import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs, num } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

// ---------------------------------------------------------------------------
// Real breakdowns from what the Strategist actually recorded — pure, no Prisma, no Anthropic, so
// this half is unit-testable the same way outbound-strategist.ts's planApolloLookups is (see
// test/content.test.ts).
//
// Before this file did any of this, the prompt below asked the model for `winningSignals`,
// `winningAngles`, and personas with nothing but four bare per-play totals (prospectsAdded,
// replied, interested, meetings) to work from — so it invented them; there was no signal- or
// persona-level data in the prompt for the model to have derived them from. Everything here exists
// to give it real slices instead, and a way to say "insufficient data" when a slice is too thin
// to mean anything, rather than confabulate a "winner" out of an n of 1.
// ---------------------------------------------------------------------------

/** Below this many prospects, a slice's reply/positive/meeting rate is dropped from being cited as
 * a "winner" — one reply out of three prospects is a 33% "rate" that means nothing. 10 is a rough
 * floor, not a statistical guarantee: it's the point below which a single event swings the rate by
 * >=10 points, which is exactly the kind of noise the old prompt had no way to filter out. */
export const MIN_SLICE_SAMPLE_SIZE = 10;

/** Mirrors the routing bands outbound-strategist.ts's own scoring tool already uses (see
 * SUBMIT_PROSPECT_INTELLIGENCE_TOOL's `routing` description: "80+: EMAIL_AND_LINKEDIN. 65-79:
 * EMAIL_ONLY. 50-64: WATCHLIST. <50: DISCARDED") — reused here rather than invented, though a
 * given play can configure its own custom routingThresholds, so a score of 66 reported here as
 * "65-79" may have routed differently for a play with non-default thresholds. Good enough for a
 * cross-play comparison (which is what this is for); not a substitute for a play's own thresholds
 * when precision matters. */
export function scoreBand(score: number): string {
  if (score >= 80) return "80-100";
  if (score >= 65) return "65-79";
  if (score >= 50) return "50-64";
  return "0-49";
}

const SENIORITY_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(chief|cxo|ceo|cto|cfo|coo|cmo|cro|president|founder|owner)\b/i, "C-Level / Founder"],
  [/\b(vp|vice president|svp|evp)\b/i, "VP"],
  [/\b(director|head of)\b/i, "Director"],
  [/\b(manager|lead)\b/i, "Manager"],
];

/**
 * Prefers Apollo's own categorical `seniority` field (see outbound-strategist.ts's
 * mapApolloPerson — Apollo's own vocabulary, e.g. "vp", "director", "c_suite", matching the same
 * values a play's ICP.seniorities filter uses, per the outbound-play-config module) since it's Apollo's
 * classification, not a re-derivation of one. Falls back to a plain keyword match against the raw
 * job title only for a prospect Apollo never enriched (or that arrived pre-enrichment) — this
 * fallback is a heuristic, not a verified classification, and says so via the bucket label never
 * claiming to be exact.
 */
export function personaBucket(title: string | null | undefined, apolloSeniority: string | null | undefined): string {
  const seniority = apolloSeniority?.trim();
  if (seniority) return seniority.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const t = title?.trim();
  if (!t) return "(no title recorded)";
  for (const [re, bucket] of SENIORITY_KEYWORDS) if (re.test(t)) return bucket;
  return "Other / IC (from title, no Apollo seniority)";
}

/** One prospect's slicing-relevant facts — a subset of OutboundProspect + its Strategist
 * intelligence + its Apollo enrichment, already flattened to plain values so buildPlaySlices needs
 * no Prisma types and no knowledge of the JSON shapes those live in. */
export interface SliceInputProspect {
  playId: string;
  channel: string;
  score: number;
  title: string | null;
  primarySignal: string | null;
  messagingAngle: string | null;
  apolloSeniority: string | null;
  replied: boolean;
  interested: boolean;
  meetingBooked: boolean;
}

export interface SliceRow {
  value: string;
  added: number;
  replied: number;
  interested: number;
  meetings: number;
  replyRate: string;
  positiveRate: string;
  meetingRate: string;
  /** True when `added` is below MIN_SLICE_SAMPLE_SIZE — the prompt below is instructed never to
   * call a row like this a winner or a loser. */
  insufficientData: boolean;
}

export interface PlaySlices {
  bySignal: SliceRow[];
  byAngle: SliceRow[];
  byPersona: SliceRow[];
  byChannel: SliceRow[];
  byScoreBand: SliceRow[];
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "0.0%";
}

/** Pure aggregator shared by every axis below: group `rows` by `bucketOf`, count outcomes, flag
 * thin slices. Exported mainly so a test can exercise the grouping/rate math directly without
 * going through a specific axis. */
export function buildSliceRows<T>(rows: T[], bucketOf: (row: T) => string, flags: { replied: (row: T) => boolean; interested: (row: T) => boolean; meetingBooked: (row: T) => boolean }): SliceRow[] {
  const byBucket = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = bucketOf(row);
    const list = byBucket.get(bucket);
    if (list) list.push(row);
    else byBucket.set(bucket, [row]);
  }
  return [...byBucket.entries()]
    .map(([value, items]) => {
      const added = items.length;
      const replied = items.filter(flags.replied).length;
      const interested = items.filter(flags.interested).length;
      const meetings = items.filter(flags.meetingBooked).length;
      return {
        value,
        added,
        replied,
        interested,
        meetings,
        replyRate: pct(replied, added),
        positiveRate: pct(interested, added),
        meetingRate: pct(meetings, added),
        insufficientData: added < MIN_SLICE_SAMPLE_SIZE,
      };
    })
    .sort((a, b) => b.added - a.added);
}

const SLICE_FLAGS = {
  replied: (r: SliceInputProspect) => r.replied,
  interested: (r: SliceInputProspect) => r.interested,
  meetingBooked: (r: SliceInputProspect) => r.meetingBooked,
};

/** `prospects` should already be limited to one play — the caller groups by playId (see the
 * handler below) so this stays a plain "here's a cohort, slice it four ways" function. */
export function buildPlaySlices(prospects: SliceInputProspect[]): PlaySlices {
  return {
    bySignal: buildSliceRows(prospects, (r) => r.primarySignal?.trim() || "(no signal recorded)", SLICE_FLAGS),
    byAngle: buildSliceRows(prospects, (r) => r.messagingAngle?.trim() || "(no angle recorded)", SLICE_FLAGS),
    byPersona: buildSliceRows(prospects, (r) => personaBucket(r.title, r.apolloSeniority), SLICE_FLAGS),
    byChannel: buildSliceRows(prospects, (r) => r.channel, SLICE_FLAGS),
    byScoreBand: buildSliceRows(prospects, (r) => scoreBand(r.score), SLICE_FLAGS),
  };
}

/** Renders one axis's rows for the prompt, sized enough to see every value the CRO play population
 * actually produced — these workspaces run a handful of plays each with dozens to low hundreds of
 * prospects per cohort, not enough rows for this to need pagination. */
function renderSliceAxis(label: string, rows: SliceRow[]): string {
  if (rows.length === 0) return `${label}: no prospects in this play's cohort.`;
  const lines = rows.map(
    (r) =>
      `  - "${r.value}": added=${r.added}, replied=${r.replied} (${r.replyRate}), interested=${r.interested} (${r.positiveRate}), meetings=${r.meetings} (${r.meetingRate})${r.insufficientData ? " [INSUFFICIENT DATA — do not cite as a winner or loser]" : ""}`,
  );
  return `${label}:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const outboundCroHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;
  const workspaceId = run.agentConfig.workspaceId;

  // Two explicit windows, not one, because they answer different questions. `lookbackDays`
  // (unchanged default 7, same input as before this file was touched) is "what happened this
  // week" — the per-play activity totals below, kept in the same shape existing callers already
  // read. `sliceWindowDays` (new, default 28) is "how big a cohort do we have to slice by signal /
  // persona / channel / score band" — a play sourcing a few dozen prospects a week has almost no
  // per-slice sample within 7 days; 28 days gives the slicing below enough rows for
  // MIN_SLICE_SAMPLE_SIZE to mean something without going so wide the data goes stale.
  const lookbackDays = typeof config.lookbackDays === "number" ? config.lookbackDays : 7;
  const sliceWindowDays = num(config, "sliceWindowDays", 28, { min: lookbackDays, max: 180 });
  const externalMetrics = input.weeklyMetrics as Record<string, unknown> | undefined;

  const now = new Date();
  const activitySince = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const sliceSince = new Date(now.getTime() - sliceWindowDays * 24 * 60 * 60 * 1000);

  const [plays, cohort] = await Promise.all([
    prisma.outboundPlay.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    // One query covers both windows: sliceSince is always <= activitySince (sliceWindowDays is
    // clamped to >= lookbackDays above), so every row the 7-day activity totals need is already
    // inside this 28-day fetch — no second round-trip to compute both.
    prisma.outboundProspect.findMany({
      where: { workspaceId, createdAt: { gte: sliceSince } },
      select: {
        id: true,
        playId: true,
        channel: true,
        score: true,
        title: true,
        status: true,
        intelligence: true,
        apolloEnrichment: true,
        createdAt: true,
        emailRepliedAt: true,
        linkedInRepliedAt: true,
        interestedAt: true,
        meetingBookedAt: true,
      },
    }),
  ]);

  // Flattened once per prospect — the same intelligence/apolloEnrichment JSON shapes
  // outbound-strategist.ts writes (scored.intelligence.primarySignal / .messagingAngle, and
  // mapApolloPerson's .seniority) — so buildPlaySlices never has to know those shapes exist.
  const flattened = cohort.map((p) => {
    const intelligence = (p.intelligence ?? {}) as { intelligence?: { primarySignal?: string; messagingAngle?: string } };
    const apollo = (p.apolloEnrichment ?? {}) as { person?: { seniority?: string } };
    const replied = !!(p.emailRepliedAt || p.linkedInRepliedAt);
    const interested = !!p.interestedAt;
    const meetingBooked = !!p.meetingBookedAt;
    return {
      id: p.id,
      playId: p.playId,
      createdAt: p.createdAt,
      // Whether this row also falls inside the narrower activity window, and whether each
      // outcome's own timestamp (not just createdAt) falls inside it — the per-play activity
      // totals below count outcomes by when they happened, same as the timestamp columns this
      // task called out (emailRepliedAt / interestedAt / meetingBookedAt), not by when the
      // prospect was sourced.
      repliedInActivityWindow: replied && !!((p.emailRepliedAt && p.emailRepliedAt >= activitySince) || (p.linkedInRepliedAt && p.linkedInRepliedAt >= activitySince)),
      interestedInActivityWindow: interested && !!(p.interestedAt && p.interestedAt >= activitySince),
      meetingInActivityWindow: meetingBooked && !!(p.meetingBookedAt && p.meetingBookedAt >= activitySince),
      slice: {
        playId: p.playId,
        channel: p.channel,
        score: p.score,
        title: p.title,
        primarySignal: intelligence.intelligence?.primarySignal ?? null,
        messagingAngle: intelligence.intelligence?.messagingAngle ?? null,
        apolloSeniority: apollo.person?.seniority ?? null,
        replied,
        interested,
        meetingBooked,
      } satisfies SliceInputProspect,
    };
  });

  // Build metrics per play — every OutboundPlay this workspace actually has, not a fixed
  // three-slug list. A workspace with no plays yet gets an empty analysis, not a report about
  // plays it never created.
  const metrics = plays.map((play) => {
    const inPlay = flattened.filter((p) => p.playId === play.id);
    const addedInActivityWindow = inPlay.filter((p) => p.createdAt >= activitySince).length;
    return {
      playSlug: play.slug,
      playName: play.name,
      prospectsAdded: addedInActivityWindow,
      replied: inPlay.filter((p) => p.repliedInActivityWindow).length,
      interested: inPlay.filter((p) => p.interestedInActivityWindow).length,
      meetings: inPlay.filter((p) => p.meetingInActivityWindow).length,
      sliceCohortSize: inPlay.length,
      slices: buildPlaySlices(inPlay.map((p) => p.slice)),
    };
  });

  const dbMetricsSummary = metrics
    .map((m) => {
      const header = `${m.playSlug} (${m.playName}) — last ${lookbackDays}d activity: added=${m.prospectsAdded}, replied=${m.replied}, interested=${m.interested}, meetings=${m.meetings}. Slice cohort (prospects sourced in the last ${sliceWindowDays}d): ${m.sliceCohortSize}.`;
      const axes = [
        renderSliceAxis("  By primary signal", m.slices.bySignal),
        renderSliceAxis("  By messaging angle", m.slices.byAngle),
        renderSliceAxis("  By persona", m.slices.byPersona),
        renderSliceAxis("  By channel", m.slices.byChannel),
        renderSliceAxis("  By score band", m.slices.byScoreBand),
      ].join("\n");
      return `${header}\n${axes}`;
    })
    .join("\n\n");
  const externalSummary = externalMetrics ? JSON.stringify(externalMetrics, null, 2) : null;

  if (plays.length === 0) {
    const output: Record<string, unknown> = {
      dbMetrics: metrics,
      executiveSummary: "No outbound plays exist for this workspace yet — nothing to analyse. Create a play on the Outbound Engine page (/outbound) and run Scout at least once first.",
      generatedAt: new Date().toISOString(),
      workspaceId,
    };
    const requireApproval = config.requireApproval !== false;
    if (requireApproval) await updateStatus("AWAITING_APPROVAL", output);
    return { output, costUsd: 0 };
  }

  const systemPrompt = `You are an outbound CRO specialist. Every Friday you review outbound performance metrics per ICP play and make data-driven recommendations.

Your job:
1. Identify which plays are performing above/below expectations
2. Surface winning signals, personas, and messaging angles — but ONLY from the slice rows given to you below, and ONLY rows not marked INSUFFICIENT DATA. Never cite a play's raw per-play totals as if they were signal- or persona-level evidence, and never invent a signal, persona, or angle that isn't one of the exact quoted values in a slice row. If every row for an axis is marked insufficient (or the axis has no rows), say so plainly for that play instead of naming a "winner" — an invented answer is worse than an honest "insufficient data" here.
3. Recommend next week's volume allocation across this workspace's plays
4. Flag any copy or sequence changes worth testing

Benchmark expectations:
- Email reply rate: 3-5% is healthy. <2% = pause and reangle.
- Positive reply rate: >1.5% of emails sent. <0.5% = reconsider the offer angle.
- LinkedIn accept rate: 25-40% of connection requests.
- Meetings: 1 per 200 contacts is the floor; 1 per 100 is good.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Generate the weekly CRO analysis and recommendations for this workspace's outbound engine.

Analysis window: the last ${lookbackDays} days of activity (added/replied/interested/meetings below) drawn from a ${sliceWindowDays}-day sourcing cohort for the slice breakdowns, so low-volume plays still have enough prospects per slice to be worth reading. A slice row marked INSUFFICIENT DATA has fewer than ${MIN_SLICE_SAMPLE_SIZE} prospects — its rate is noise, not a finding.

Plays in this workspace: ${plays.map((p) => `${p.slug} (${p.name})`).join(", ")}

DB Metrics and slices (from outbound_prospect, per play):
${dbMetricsSummary}

${externalSummary ? `External metrics provided:\n${externalSummary}` : "Note: No external metrics provided. Base analysis on DB data only."}

Return exactly this JSON structure — one playAnalysis entry and one nextWeekAllocation key per play listed above, using each play's own slug:
{
  "period": {
    "activityDays": ${lookbackDays},
    "sliceCohortDays": ${sliceWindowDays},
    "label": "string (e.g. 'Week of Sep 1–7, 2026')"
  },
  "playAnalysis": [
    {
      "playSlug": "string — one of the play slugs listed above",
      "playName": "string",
      "metrics": {
        "prospectsAdded": 0,
        "replied": 0,
        "replyRate": "0.0%",
        "interested": 0,
        "positiveRate": "0.0%",
        "meetings": 0
      },
      "assessment": "string (2-3 sentences — performance vs benchmark)",
      "decision": "INCREASE_VOLUME" | "CONTINUE" | "PAUSE_REANGLE" | "PAUSE",
      "decisionRationale": "string",
      "bestSignal": "string — the exact quoted value of the best-performing sufficient-data row in this play's 'By primary signal' slice, or \\"insufficient data\\" if none qualify",
      "bestPersona": "string — same rule, from 'By persona'",
      "worstScoreBand": "string — the exact quoted value of the weakest sufficient-data row in 'By score band', or \\"insufficient data\\""
    }
  ],
  "nextWeekAllocation": {
    "totalDaily": 0,
    "byPlay": { "playSlug": 0 },
    "allocationNote": "string"
  },
  "winningSignals": ["string — exact quoted slice values only, across all plays, each with its play noted inline; empty array if none qualify"],
  "winningPersonas": ["string — exact quoted slice values only, same rule; empty array if none qualify"],
  "winningAngles": ["string — exact quoted slice values only, same rule; empty array if none qualify"],
  "testRecommendations": [
    {
      "play": "string",
      "hypothesis": "string",
      "change": "string (what to test)",
      "priority": "HIGH" | "MEDIUM" | "LOW"
    }
  ],
  "executiveSummary": "string (3-4 sentence narrative for weekly team update, naming 'insufficient data' explicitly wherever the analysis couldn't call a winner)"
}`;

  const message = await client.messages.create({
    model: MODELS.standard,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.dbMetrics = metrics;
  output.analysisWindow = { activityDays: lookbackDays, sliceCohortDays: sliceWindowDays };
  output.generatedAt = new Date().toISOString();
  output.workspaceId = workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};
