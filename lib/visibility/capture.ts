import type { AnswerEngine } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { ENGINE_NAMES, availableEngines, geminiDomain, hostOf, type AnswerEngineClient } from "@/lib/answer-engines";
import { analyseMentions, classifySentiment } from "./analyse";
import { resolveBrand, type BrandIdentity } from "./brand";
import { METRICS, dayKey, recordObservations, type ObservationInput } from "./observations";
import { MAX_PROMPTS_PER_CAPTURE } from "./budget";
import { pruneAnswerText } from "./retention";

export interface CaptureFailure {
  prompt: string;
  engine: AnswerEngine;
  error: string;
}

export interface CaptureResult {
  day: string;
  engines: AnswerEngine[];
  prompts: number;
  /** Active prompts beyond MAX_PROMPTS_PER_CAPTURE that this run did not ask. */
  skippedPrompts: number;
  captured: number;
  failures: CaptureFailure[];
  costUsd: number;
  observations: number;
}

/** How many engine calls run at once. Bounded so one capture cannot saturate a
 *  workspace's rate limits and take the rest of the fleet down with it. */
const CONCURRENCY = 4;

/**
 * Ask every connected engine every tracked prompt, and store what they said.
 *
 * This is the function that replaces a simulation. The agent it backs used to
 * ask a model to *imagine* how ChatGPT would answer; this asks the engines and
 * keeps the answer. The difference shows up in two places that matter: the
 * figures become comparable across days, and a workspace with no engine keys
 * now gets a refusal instead of a plausible number.
 *
 * Partial failure is normal and is not fatal. One engine rate-limiting must
 * not discard three engines' worth of captures, so failures are collected and
 * returned, and the day is derived from whatever did land. A day with fewer
 * captures is visible in the CAPTURES metric rather than silently thinner.
 */
export async function captureVisibility(
  workspaceId: string,
  opts: { runId?: string; promptIds?: string[]; now?: Date } = {},
): Promise<CaptureResult> {
  const now = opts.now ?? new Date();
  const day = dayKey(now);

  const brand = await resolveBrand(workspaceId);
  if (!brand) {
    throw new AgentInputError(
      "This workspace has no business profile, so there is no brand to measure.",
      "Complete onboarding, or set a business name and website under Settings, then run this again.",
      "missing_business_profile",
    );
  }

  const engines = await availableEngines(workspaceId);
  if (engines.length === 0) {
    throw new AgentInputError(
      "No answer engine is connected, so there is nothing to measure.",
      "Connect at least one of OpenAI, Google Gemini, Perplexity or Anthropic under Settings → Integrations. Captures run on your own keys, and we will not estimate what an engine might have said.",
      "no_answer_engine",
    );
  }

  // Capped, not unbounded. See MAX_PROMPTS_PER_CAPTURE — a pasted list of six
  // hundred prompts must not silently become a forty-fold spend increase on
  // the customer's own key, run by a scheduler nobody is watching.
  const [promptTotal, prompts] = await Promise.all([
    prisma.trackedPrompt.count({
      where: {
        workspaceId,
        active: true,
        ...(opts.promptIds?.length ? { id: { in: opts.promptIds } } : {}),
      },
    }),
    prisma.trackedPrompt.findMany({
      where: {
        workspaceId,
        active: true,
        ...(opts.promptIds?.length ? { id: { in: opts.promptIds } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: MAX_PROMPTS_PER_CAPTURE,
    }),
  ]);
  const skippedPrompts = Math.max(promptTotal - prompts.length, 0);

  if (prompts.length === 0) {
    throw new AgentInputError(
      "No prompts are being tracked, so there is nothing to ask.",
      "Add the questions your customers ask an assistant under AI Visibility → Prompts, then run this again.",
      "no_tracked_prompts",
    );
  }

  const { client: anthropic } = await resolveAnthropic(workspaceId);

  const jobs: Array<{ prompt: (typeof prompts)[number]; engine: AnswerEngineClient }> = [];
  for (const prompt of prompts) {
    for (const engine of engines) jobs.push({ prompt, engine });
  }

  const failures: CaptureFailure[] = [];
  let captured = 0;
  let costUsd = 0;

  await pool(jobs, CONCURRENCY, async ({ prompt, engine }) => {
    try {
      const answer = await engine.ask(prompt.text);
      const mentions = analyseMentions(answer.text, brand);

      let sentiment: string | null = null;
      let sentimentCost = 0;
      if (mentions.brandMentioned) {
        const classified = await classifySentiment(anthropic, brand.name, answer.text);
        sentiment = classified.sentiment;
        sentimentCost = classified.costUsd;
      }

      const total = answer.costUsd + sentimentCost;

      // One row per prompt per engine per day. A re-run corrects the day
      // rather than doubling it — the whole point of capturedOn.
      const capture = await prisma.answerCapture.upsert({
        where: {
          promptId_engine_capturedOn: { promptId: prompt.id, engine: engine.engine, capturedOn: day },
        },
        create: {
          workspaceId,
          promptId: prompt.id,
          engine: engine.engine,
          model: answer.model,
          answerText: answer.text,
          brandMentioned: mentions.brandMentioned,
          brandRank: mentions.brandRank,
          sentiment,
          competitors: mentions.competitors,
          costUsd: total,
          runId: opts.runId,
          capturedAt: now,
          capturedOn: day,
        },
        update: {
          model: answer.model,
          answerText: answer.text,
          brandMentioned: mentions.brandMentioned,
          brandRank: mentions.brandRank,
          sentiment,
          competitors: mentions.competitors,
          costUsd: total,
          runId: opts.runId,
          capturedAt: now,
        },
      });

      // Citations are replaced wholesale, not merged: the second capture of a
      // day is a correction of the first, and merging would leave links from
      // an answer that no longer exists counting towards citation share.
      await prisma.citation.deleteMany({ where: { captureId: capture.id, workspaceId } });
      const citations = answer.citations
        .map((c) => {
          const domain = engine.engine === "GEMINI" ? geminiDomain(c) : hostOf(c.url);
          return domain ? { domain, url: c.url, position: c.position } : null;
        })
        .filter((c): c is { domain: string; url: string; position: number } => c !== null);

      if (citations.length > 0) {
        await prisma.citation.createMany({
          data: citations.map((c) => ({
            captureId: capture.id,
            workspaceId,
            domain: c.domain,
            url: c.url,
            position: c.position,
            isOwned: brand.domain !== null && c.domain === brand.domain,
            capturedAt: now,
          })),
        });
      }

      captured += 1;
      costUsd += total;
    } catch (err) {
      failures.push({
        prompt: prompt.text,
        engine: engine.engine,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  if (captured === 0) {
    const detail = failures
      .slice(0, 3)
      .map((f) => `${ENGINE_NAMES[f.engine]}: ${f.error}`)
      .join(" · ");
    throw new AgentInputError(
      "Every engine call failed, so nothing was measured.",
      detail || "Check the engine keys under Settings → Integrations.",
      "capture_failed",
    );
  }

  const observations = await deriveDay(workspaceId, day, brand);

  // Drop prose past the retention window. Metrics, citations and the capture
  // rows themselves are kept — only the text goes, and only once it is far too
  // old to re-derive from. Failing to prune must never fail a capture that
  // otherwise succeeded.
  const pruned = await pruneAnswerText(workspaceId).catch((err) => {
    console.error(`[visibility] pruning answer text failed for ${workspaceId}:`, err);
    return 0;
  });
  if (pruned > 0) console.log(`[visibility] pruned answer text on ${pruned} old captures`);

  return {
    day,
    engines: engines.map((e) => e.engine),
    prompts: prompts.length,
    skippedPrompts,
    captured,
    failures,
    costUsd,
    observations,
  };
}

/**
 * Turn a day's captures into the figures the dashboard reads.
 *
 * Derived from stored captures rather than computed inline during capture, so
 * a correction to how a metric is defined can be re-applied to history — which
 * is also why AnswerCapture keeps the full answer text.
 */
export async function deriveDay(workspaceId: string, day: string, brandIn?: BrandIdentity): Promise<number> {
  const brand = brandIn ?? (await resolveBrand(workspaceId));
  if (!brand) return 0;

  const captures = await prisma.answerCapture.findMany({
    where: { workspaceId, capturedOn: day },
    select: { engine: true, brandMentioned: true, brandRank: true, sentiment: true, competitors: true },
  });
  if (captures.length === 0) return 0;

  const rows: ObservationInput[] = [];
  const source = "ANSWER_CAPTURE";

  const push = (subject: string, metric: string, value: number, dimensions?: Record<string, string>) =>
    rows.push({ subject, metric, value, dimensions, source, observedOn: day });

  // Overall and per engine, for us and for every competitor we track.
  const slices: Array<{ dimensions?: Record<string, string>; rows: typeof captures }> = [
    { rows: captures },
    ...[...new Set(captures.map((c) => c.engine))].map((engine) => ({
      dimensions: { engine },
      rows: captures.filter((c) => c.engine === engine),
    })),
  ];

  for (const slice of slices) {
    const n = slice.rows.length;
    if (n === 0) continue;

    const mentioned = slice.rows.filter((c) => c.brandMentioned);
    push(BRAND_SUBJECT, METRICS.CAPTURES, n, slice.dimensions);
    push(BRAND_SUBJECT, METRICS.MENTIONS, mentioned.length, slice.dimensions);
    push(BRAND_SUBJECT, METRICS.VISIBILITY, pct(mentioned.length, n), slice.dimensions);

    const ranked = mentioned.map((c) => c.brandRank).filter((r): r is number => typeof r === "number");
    if (ranked.length > 0) {
      push(BRAND_SUBJECT, METRICS.BRAND_RANK, mean(ranked), slice.dimensions);
    }

    const scored = mentioned
      .map((c) => SENTIMENT_SCORE[c.sentiment ?? ""])
      .filter((v): v is number => typeof v === "number");
    if (scored.length > 0) {
      push(BRAND_SUBJECT, METRICS.SENTIMENT, mean(scored), slice.dimensions);
    }

    for (const competitor of brand.competitors) {
      // "brand" is this workspace's own subject. A competitor literally named
      // "brand" would otherwise overwrite our own visibility row through the
      // same compound unique — unlikely, and silent if it ever happened.
      if (competitor.name === BRAND_SUBJECT) continue;
      const hits = slice.rows.filter((c) => c.competitors.includes(competitor.name)).length;
      push(competitor.name, METRICS.MENTIONS, hits, slice.dimensions);
      push(competitor.name, METRICS.VISIBILITY, pct(hits, n), slice.dimensions);
    }
  }

  // Citation share by domain, over the same day.
  const citations = await prisma.citation.groupBy({
    by: ["domain"],
    where: { workspaceId, capture: { capturedOn: day } },
    _count: { _all: true },
  });
  const totalCitations = citations.reduce((sum, c) => sum + c._count._all, 0);
  for (const c of citations) {
    push(c.domain, METRICS.CITATION_SHARE, pct(c._count._all, totalCitations));
  }

  await recordObservations(workspaceId, rows);
  return rows.length;
}

/** The reserved Observation.subject for the workspace's own brand. */
export const BRAND_SUBJECT = "brand";

const SENTIMENT_SCORE: Record<string, number> = { POSITIVE: 1, NEUTRAL: 0, NEGATIVE: -1 };

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

function mean(values: number[]): number {
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

/** Run `work` over `items` with at most `size` in flight. */
async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await work(item);
    }
  });
  await Promise.all(workers);
}
