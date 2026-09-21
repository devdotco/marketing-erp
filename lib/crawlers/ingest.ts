import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { prisma } from "@/lib/prisma";
import { identifyCrawler } from "./bots";
import { identifyReferrer } from "./referrers";
import { newVerifyBudget, verifyCrawler } from "./verify";

/**
 * One Cloudflare Logpush batch, turned into daily counters.
 *
 * The shape of the work: parse, classify, aggregate in memory, then write one
 * upsert per distinct (day, bot, path). A batch of 50,000 lines against a site
 * with 300 pages is a few hundred writes, not 50,000 — which is what makes
 * this affordable to run on every push.
 */

/** Fields we ask for in the Logpush job. Others are ignored if present. */
interface LogLine {
  ClientRequestHost?: string;
  ClientRequestPath?: string;
  ClientRequestUserAgent?: string;
  ClientIP?: string;
  ClientRequestReferer?: string;
  EdgeResponseStatus?: number;
  EdgeStartTimestamp?: string | number;
}

export interface IngestResult {
  lines: number;
  crawlerHits: number;
  referralHits: number;
  crawlerRows: number;
  referralRows: number;
  /** True when this exact batch had already been counted. */
  duplicate: boolean;
}

/** Hard ceiling on one batch, so a runaway push cannot hold a worker forever. */
const MAX_LINES = 100_000;

export async function ingestLogBatch(
  workspaceId: string,
  body: Buffer,
  opts: { hosts?: string[] } = {},
): Promise<IngestResult> {
  // Idempotency first, before any parsing. Cloudflare retries any batch it did
  // not get a 2xx for, and a retry after a partial write would double every
  // counter in it. Hashing the body needs nothing from Cloudflare and is
  // stable across a retry of the identical payload — which is what a retry is.
  const hash = createHash("sha256").update(body).digest("hex");
  const seen = await prisma.logBatchReceipt.findUnique({ where: { hash } });
  if (seen) {
    return { lines: seen.lines, crawlerHits: 0, referralHits: 0, crawlerRows: 0, referralRows: 0, duplicate: true };
  }

  const text = decode(body);
  const lines = text.split("\n").filter((l) => l.trim().length > 0).slice(0, MAX_LINES);

  const hosts = (opts.hosts ?? []).map((h) => h.toLowerCase().replace(/^www\./, ""));
  const budget = newVerifyBudget();

  const crawlers = new Map<string, { day: string; bot: string; path: string; hits: number; verified: number; errors: number }>();
  const referrals = new Map<string, { day: string; source: string; path: string; visits: number }>();
  let crawlerHits = 0;
  let referralHits = 0;

  for (const raw of lines) {
    let line: LogLine;
    try {
      line = JSON.parse(raw) as LogLine;
    } catch {
      continue; // One malformed line must not discard a batch.
    }

    // A workspace that named its hosts only counts those. Without it, a shared
    // Logpush job would attribute another site's traffic to this workspace.
    if (hosts.length > 0) {
      const host = (line.ClientRequestHost ?? "").toLowerCase().replace(/^www\./, "");
      if (!hosts.includes(host)) continue;
    }

    const day = dayOf(line.EdgeStartTimestamp);
    const path = normalisePath(line.ClientRequestPath);
    const status = Number(line.EdgeResponseStatus ?? 0);

    const crawler = identifyCrawler(line.ClientRequestUserAgent ?? "");
    if (crawler) {
      const result = await verifyCrawler(crawler, line.ClientIP ?? "", budget);
      const key = `${day}|${crawler.key}|${path}`;
      const row = crawlers.get(key) ?? { day, bot: crawler.key, path, hits: 0, verified: 0, errors: 0 };
      row.hits += 1;
      if (result === "verified") row.verified += 1;
      if (status >= 400) row.errors += 1;
      crawlers.set(key, row);
      crawlerHits += 1;
      continue; // A bot is never also a referral.
    }

    const referrer = identifyReferrer(line.ClientRequestReferer ?? "");
    if (referrer) {
      // Only a page a person could have landed on. An asset request carrying
      // the same referrer is the same visit counted again.
      if (looksLikeAsset(path)) continue;
      const key = `${day}|${referrer.key}|${path}`;
      const row = referrals.get(key) ?? { day, source: referrer.key, path, visits: 0 };
      row.visits += 1;
      referrals.set(key, row);
      referralHits += 1;
    }
  }

  for (const row of crawlers.values()) {
    await prisma.crawlerDaily.upsert({
      where: {
        workspaceId_day_bot_path: { workspaceId, day: row.day, bot: row.bot, path: row.path },
      },
      create: {
        workspaceId,
        day: row.day,
        bot: row.bot,
        path: row.path,
        hits: row.hits,
        verifiedHits: row.verified,
        errorHits: row.errors,
      },
      // Increment, never assign: a day receives many batches, and the second
      // one must add to the first rather than replace it.
      update: {
        hits: { increment: row.hits },
        verifiedHits: { increment: row.verified },
        errorHits: { increment: row.errors },
        lastSeenAt: new Date(),
      },
    });
  }

  for (const row of referrals.values()) {
    await prisma.referralDaily.upsert({
      where: {
        workspaceId_day_source_path: { workspaceId, day: row.day, source: row.source, path: row.path },
      },
      create: { workspaceId, day: row.day, source: row.source, path: row.path, visits: row.visits },
      update: { visits: { increment: row.visits }, lastSeenAt: new Date() },
    });
  }

  // Written last. A receipt stored before the counters would mean a crash
  // midway through loses the batch permanently — Cloudflare's retry would be
  // rejected as a duplicate of work that never landed.
  await prisma.logBatchReceipt.create({ data: { hash, workspaceId, lines: lines.length } });

  return {
    lines: lines.length,
    crawlerHits,
    referralHits,
    crawlerRows: crawlers.size,
    referralRows: referrals.size,
    duplicate: false,
  };
}

/** Logpush gzips by default, and sends plain NDJSON when told not to. */
function decode(body: Buffer): string {
  const isGzip = body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;
  return (isGzip ? gunzipSync(body) : body).toString("utf8");
}

/**
 * The UTC day a log line belongs to.
 *
 * Logpush emits the timestamp as RFC3339 or as an integer, and the integer's
 * unit depends on how the job was configured — seconds, milliseconds,
 * microseconds or nanoseconds. Guessing wrong by a factor of a thousand files
 * every hit under 1970 or the year 55000, so the magnitude decides the unit.
 */
export function dayOf(value: string | number | undefined): string {
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms =
      value > 1e17 ? value / 1e6 // nanoseconds
      : value > 1e14 ? value / 1e3 // microseconds
      : value > 1e11 ? value // milliseconds
      : value * 1000; // seconds
    return new Date(ms).toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * One path per page.
 *
 * Query strings are dropped: a tracking parameter would otherwise split one
 * page into hundreds of rows, each with a hit count of one, and the "most
 * crawled pages" table would show nothing but noise. A trailing slash is
 * dropped for the same reason, and the path is capped so a pathological URL
 * cannot bloat the table.
 */
export function normalisePath(path: string | undefined): string {
  if (!path) return "/";
  const withoutQuery = path.split("?")[0].split("#")[0];
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
  return (trimmed || "/").slice(0, 512);
}

const ASSET_EXTENSIONS =
  /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|xml|txt|json)$/i;

export function looksLikeAsset(path: string): boolean {
  return ASSET_EXTENSIONS.test(path) || path.startsWith("/_next/") || path.startsWith("/static/");
}
