/**
 * Log ingest against a real Postgres. Needs a throwaway DATABASE_URL — these
 * tests WRITE. Run with `npm run test:crawlers:db`.
 *
 * What units cannot reach: the batch-hash idempotency that makes a Cloudflare
 * retry safe, the increment-not-assign upsert that lets a day receive many
 * batches, and the host filter that stops one Logpush job attributing another
 * site's traffic to this workspace.
 *
 * Every fixture uses a crawler whose verification method is "none"
 * (ClaudeBot, PerplexityBot), so nothing here makes a DNS or HTTP call.
 */
import { gzipSync } from "node:zlib";
import { prisma } from "@/lib/prisma";
import { ingestLogBatch } from "@/lib/crawlers/ingest";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

const TS = "2026-09-20T10:00:00Z";

/**
 * A nonce carried on every fixture line.
 *
 * The ingest deduplicates by hashing the batch body, and LogBatchReceipt rows
 * outlive a test run — so without this, a second run of this file would see
 * its own first run's batches as Cloudflare retries and skip every write. The
 * field is not one the parser reads; it exists only to make each run's bytes
 * different, which is exactly what distinguishes a new batch from a retry in
 * production too.
 */
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    RayID: RUN,
    ClientRequestHost: "acme.com",
    ClientRequestPath: "/pricing",
    ClientRequestUserAgent: "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
    ClientIP: "203.0.113.10",
    ClientRequestReferer: "",
    EdgeResponseStatus: 200,
    EdgeStartTimestamp: TS,
    ...over,
  });
}

const batch = (lines: string[]) => Buffer.from(lines.join("\n"), "utf8");

async function main() {
  const ws = await prisma.workspace.create({ data: { name: "Crawl QA", slug: `crawl-${Date.now()}` } });

  // ── A first batch lands ───────────────────────────────────────────────────
  const first = batch([
    line(),
    line(),
    line({ ClientRequestPath: "/about" }),
    line({ ClientRequestUserAgent: "PerplexityBot/1.0", ClientRequestPath: "/pricing" }),
    line({ ClientRequestPath: "/gone", EdgeResponseStatus: 404 }),
    // A human arriving from ChatGPT.
    line({ ClientRequestUserAgent: "Mozilla/5.0 Safari", ClientRequestReferer: "https://chatgpt.com/c/1", ClientRequestPath: "/pricing" }),
    // Same visit's stylesheet — must not count as a second visit.
    line({ ClientRequestUserAgent: "Mozilla/5.0 Safari", ClientRequestReferer: "https://chatgpt.com/c/1", ClientRequestPath: "/app.css" }),
    // Another site in the same Logpush job.
    line({ ClientRequestHost: "somebodyelse.com", ClientRequestPath: "/secret" }),
  ]);

  const r1 = await ingestLogBatch(ws.id, first, { hosts: ["acme.com"] });
  check("the batch is not reported as a duplicate", r1.duplicate === false, r1);
  check("crawler hits counted", r1.crawlerHits === 5, r1);
  check("referral hits counted once, not twice", r1.referralHits === 1, r1);

  const pricing = await prisma.crawlerDaily.findUnique({
    where: { workspaceId_day_bot_path: { workspaceId: ws.id, day: "2026-09-20", bot: "ClaudeBot", path: "/pricing" } },
  });
  check("repeated requests to one path are one row with a count", pricing?.hits === 2, pricing);
  check("nothing was verified — ClaudeBot publishes nothing to check", pricing?.verifiedHits === 0, pricing);

  const gone = await prisma.crawlerDaily.findUnique({
    where: { workspaceId_day_bot_path: { workspaceId: ws.id, day: "2026-09-20", bot: "ClaudeBot", path: "/gone" } },
  });
  check("a 404 served to a crawler is recorded as an error", gone?.errorHits === 1, gone);

  const foreign = await prisma.crawlerDaily.findFirst({ where: { workspaceId: ws.id, path: "/secret" } });
  check("another host's traffic is not attributed to this workspace", foreign === null, foreign);

  const referral = await prisma.referralDaily.findUnique({
    where: { workspaceId_day_source_path: { workspaceId: ws.id, day: "2026-09-20", source: "ChatGPT", path: "/pricing" } },
  });
  check("the AI referral landed on the page, not the stylesheet", referral?.visits === 1, referral);
  const asset = await prisma.referralDaily.findFirst({ where: { workspaceId: ws.id, path: "/app.css" } });
  check("an asset request is not a second visit", asset === null, asset);

  // ── The same batch again: Cloudflare's retry ─────────────────────────────
  const r2 = await ingestLogBatch(ws.id, first, { hosts: ["acme.com"] });
  check("a redelivered batch is recognised as a duplicate", r2.duplicate === true, r2);
  const afterRetry = await prisma.crawlerDaily.findUnique({
    where: { workspaceId_day_bot_path: { workspaceId: ws.id, day: "2026-09-20", bot: "ClaudeBot", path: "/pricing" } },
  });
  check("a retry does not double the counters", afterRetry?.hits === 2, afterRetry);

  // ── A different batch on the same day must ADD, not replace ──────────────
  const second = batch([line(), line({ ClientRequestPath: "/new" })]);
  const r3 = await ingestLogBatch(ws.id, second, { hosts: ["acme.com"] });
  check("a genuinely new batch is accepted", r3.duplicate === false, r3);
  const afterSecond = await prisma.crawlerDaily.findUnique({
    where: { workspaceId_day_bot_path: { workspaceId: ws.id, day: "2026-09-20", bot: "ClaudeBot", path: "/pricing" } },
  });
  check("a second batch increments the day rather than overwriting it", afterSecond?.hits === 3, afterSecond);

  // ── gzip, which is what Logpush actually sends ───────────────────────────
  const gz = gzipSync(batch([line({ ClientRequestPath: "/gzipped" })]));
  const r4 = await ingestLogBatch(ws.id, gz, { hosts: ["acme.com"] });
  check("a gzipped batch is decoded", r4.crawlerHits === 1, r4);
  const gzRow = await prisma.crawlerDaily.findFirst({ where: { workspaceId: ws.id, path: "/gzipped" } });
  check("and its rows are written", gzRow?.hits === 1, gzRow);

  // ── No host filter means accept everything in the job ────────────────────
  const ws2 = await prisma.workspace.create({ data: { name: "Crawl QA 2", slug: `crawl2-${Date.now()}` } });
  const r5 = await ingestLogBatch(ws2.id, batch([line({ ClientRequestHost: "anything.example" })]), {});
  check("with no hosts configured, every host is accepted", r5.crawlerHits === 1, r5);

  // ── Isolation ────────────────────────────────────────────────────────────
  // ws2 has its own /pricing row from its own batch, so counting that path
  // proves nothing. Count paths only ws ever received.
  const leaked = await prisma.crawlerDaily.count({
    where: { workspaceId: ws2.id, path: { in: ["/gone", "/gzipped", "/about", "/new"] } },
  });
  check("one workspace's crawl data does not appear in another", leaked === 0, leaked);
  const ws2Rows = await prisma.crawlerDaily.count({ where: { workspaceId: ws2.id } });
  check("and it holds only the single row from its own batch", ws2Rows === 1, ws2Rows);

  // ── A malformed line must not discard the batch ──────────────────────────
  const ws3 = await prisma.workspace.create({ data: { name: "Crawl QA 3", slug: `crawl3-${Date.now()}` } });
  const r6 = await ingestLogBatch(ws3.id, batch(["{not json", line({ ClientRequestPath: "/survived" })]), {});
  check("a malformed line is skipped and the rest still lands", r6.crawlerHits === 1, r6);

  await prisma.workspace.deleteMany({ where: { id: { in: [ws.id, ws2.id, ws3.id] } } });
  const orphans = await prisma.crawlerDaily.count({ where: { workspaceId: ws.id } });
  check("deleting a workspace cascades its crawl data away", orphans === 0, orphans);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error("\nTHREW:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
