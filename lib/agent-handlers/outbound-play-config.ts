/**
 * OutboundPlay.config — the typed, validated shape every outbound agent reads instead of the
 * three hardcoded Dev.co plays that used to be baked into the code (outbound-scout.ts's
 * ICP_DEFINITIONS/APOLLO_FILTERS, outbound-strategist.ts's ICP_FIRMOGRAPHIC_BANDS,
 * outbound-email.ts's CAMPAIGN_MAP, outbound-linkedin.ts's AIMFOX_CAMPAIGN_MAP). A workspace's
 * plays are rows in OutboundPlay; this file is only the shape of the `config` JSON column on each
 * row — no Prisma import here so it stays importable from client code (the plays editor) and pure
 * test files.
 *
 * Pure/no-network — parsing, filter-building, and a couple of small pipeline helpers only. See
 * test/content.test.ts for coverage.
 */
import { z } from "zod";

export const OutboundPlayIcpSchema = z.object({
  /** Job titles Apollo's `person_titles` filter accepts, e.g. "VP Engineering". */
  titles: z.array(z.string()).default([]),
  /** Apollo `person_seniorities` values, e.g. "vp", "director", "c_suite". */
  seniorities: z.array(z.string()).default([]),
  /** Informational only today — see buildApolloPeopleSearchFilters's comment on why this isn't
   * sent to Apollo (no confirmed department filter param). */
  departments: z.array(z.string()).default([]),
  /** Apollo `organization_num_employees_ranges` values, "min,max" strings e.g. "51,500". */
  employeeRanges: z.array(z.string()).default([]),
  /** Free-text industry/keyword terms sent as Apollo's `q_organization_keyword_tags`. */
  industries: z.array(z.string()).default([]),
  /** Apollo `person_locations` values, e.g. "United States". */
  geographies: z.array(z.string()).default([]),
  /** Informational only today — see buildApolloPeopleSearchFilters's comment; Apollo's technology
   * filter needs technology UIDs this codebase has no verified lookup for. */
  technologies: z.array(z.string()).default([]),
  /** Company name / domain substrings (case-insensitive) to drop from Scout's results — checked
   * client-side against Apollo's response, not sent as an Apollo filter (see matchesExclusion). */
  exclusions: z.array(z.string()).default([]),
});
export type OutboundPlayIcp = z.infer<typeof OutboundPlayIcpSchema>;

const ScoringWeightsSchema = z
  .object({
    signal: z.number().min(0).max(25),
    serviceFit: z.number().min(0).max(20),
    firmographic: z.number().min(0).max(25),
    persona: z.number().min(0).max(15),
    timing: z.number().min(0).max(10),
    dataQuality: z.number().min(0).max(5),
  })
  .partial()
  .default({});
export type OutboundScoringWeights = z.infer<typeof ScoringWeightsSchema>;

/** Every dimension the Strategist scores a prospect on, in the fixed order the scoring prompt and
 * tool schema present them. Shared so resolveScoringWeights/computeWeightedTotal and
 * outbound-strategist.ts's ScoredProspect type always agree on the same six keys. */
export const SCORING_DIMENSIONS = ["signal", "serviceFit", "firmographic", "persona", "timing", "dataQuality"] as const;
export type ScoringDimension = (typeof SCORING_DIMENSIONS)[number];

/** The maxima every play used to get hardcoded into the scoring prompt (and, before this, the only
 * maxima that existed at all — scoringWeights was stored on OutboundPlayConfig but never read by
 * anything). These stay the fallback for any dimension a play hasn't overridden, and the starting
 * point resolveScoringWeights normalises from. */
export const DEFAULT_SCORING_WEIGHTS: Record<ScoringDimension, number> = {
  signal: 25,
  serviceFit: 20,
  firmographic: 25,
  persona: 15,
  timing: 10,
  dataQuality: 5,
};

const RoutingThresholdsSchema = z
  .object({
    emailAndLinkedin: z.number().min(0).max(100).default(80),
    emailOnly: z.number().min(0).max(100).default(65),
    watchlist: z.number().min(0).max(100).default(50),
  })
  .default({ emailAndLinkedin: 80, emailOnly: 65, watchlist: 50 });
export type OutboundRoutingThresholds = z.infer<typeof RoutingThresholdsSchema>;

export const OutboundPlayConfigSchema = z.object({
  // prefault (not default): zod v4's `.default()` substitutes its value as-is without parsing it
  // through the inner schema, so a completely-absent `icp` key would come out as `{}` with none of
  // OutboundPlayIcpSchema's own per-field array defaults applied. `.prefault()` parses the default
  // through the schema first, so every array field still ends up `[]` rather than undefined.
  icp: OutboundPlayIcpSchema.prefault({}),
  /** What this play is selling — grounds every downstream agent's messaging instead of an
   * implicit "Dev.co" assumption baked into a prompt. */
  serviceOffer: z.string().default(""),
  proofPoints: z.array(z.string()).default([]),
  scoringWeights: ScoringWeightsSchema,
  routingThresholds: RoutingThresholdsSchema,
  /** A real Instantly campaign id from this workspace's own account — chosen via the dropdown in
   * the play editor (GET /api/outbound/integrations/options?provider=INSTANTLY). Set directly
   * skips outbound-email.ts's by-name lookup entirely. */
  instantlyCampaignId: z.string().optional(),
  /** Kept alongside the id for display, and as the only thing sold when Instantly isn't connected
   * yet (a plain text field in that case — see the play editor). */
  instantlyCampaignName: z.string().optional(),
  aimfoxCampaignId: z.string().optional(),
  aimfoxCampaignName: z.string().optional(),
  /** A GoHighLevel pipeline id from Settings → Business Profile → Pipelines in the sub-account.
   * Optional — outbound-revenue.ts falls back to its existing by-name ("Outbound") resolution when
   * unset. */
  ghlPipelineId: z.string().optional(),
  ghlPipelineName: z.string().optional(),
  /** Whether a completed/approved Scout or Strategist run for this play automatically enqueues the
   * next stage. Default on — see lib/agent-handlers/chaining.ts. */
  autoAdvance: z.boolean().default(true),
  /** Upper bound on how many prospects Scout sources for this play in one run. */
  dailySourcingCap: z.number().int().min(1).max(500).default(30),
});
export type OutboundPlayConfig = z.infer<typeof OutboundPlayConfigSchema>;

/** Safe-parses OutboundPlay.config (whatever shape it happens to be — `{}` for a brand-new play,
 * or a partial/legacy object) into the full typed shape with every default filled in. Never
 * throws: an invalid/missing field just falls back to its default rather than blocking every
 * agent that reads this play. */
export function parsePlayConfig(raw: unknown): OutboundPlayConfig {
  const result = OutboundPlayConfigSchema.safeParse(raw !== null && typeof raw === "object" ? raw : {});
  if (result.success) return result.data;
  // Fall back to an empty object's defaults rather than surfacing a Zod error to an agent run —
  // a malformed config (hand-edited JSON, a future field this version doesn't know) degrades to
  // "no filters configured" instead of failing the run outright.
  return OutboundPlayConfigSchema.parse({});
}

/**
 * Apollo People Search filters built from a play's ICP — param names verified against
 * docs.apollo.io/docs/find-people-using-filters and cross-referenced third-party integrations
 * (2026-09-14): person_titles, person_seniorities, person_locations,
 * organization_num_employees_ranges (already used successfully by this codebase before this
 * rebuild), and q_organization_keyword_tags for free-text industry/keyword matching.
 *
 * `departments` and `technologies` are deliberately NOT sent: Apollo's documented department and
 * technology filters (organization_industry_tag_ids / *_technology_uids-style params) require
 * Apollo-assigned tag/UID values this codebase has no verified lookup for, and guessing a filter
 * param risks a silent 422 or an empty result set that looks like "no prospects match" instead of
 * a config problem. Both fields are still stored and shown in the play editor as reference/intent;
 * see the task report for what would be needed to wire them up for real.
 */
export function buildApolloPeopleSearchFilters(icp: OutboundPlayIcp): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (icp.titles.length > 0) filters.person_titles = icp.titles;
  if (icp.seniorities.length > 0) filters.person_seniorities = icp.seniorities;
  if (icp.geographies.length > 0) filters.person_locations = icp.geographies;
  if (icp.employeeRanges.length > 0) filters.organization_num_employees_ranges = icp.employeeRanges;
  if (icp.industries.length > 0) filters.q_organization_keyword_tags = icp.industries;
  return filters;
}

/** True when an Apollo person result's organization name/domain matches one of the play's
 * exclusion terms (case-insensitive substring) — applied client-side after the search comes back,
 * since no Apollo filter param for "exclude these companies" is confirmed (see the module doc). */
export function matchesExclusion(
  org: { name?: unknown; primary_domain?: unknown; website_url?: unknown } | null | undefined,
  exclusions: string[],
): boolean {
  if (exclusions.length === 0 || !org) return false;
  const haystack = [org.name, org.primary_domain, org.website_url]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => v.toLowerCase())
    .join(" | ");
  if (!haystack) return false;
  return exclusions.some((term) => term.trim().length > 0 && haystack.includes(term.trim().toLowerCase()));
}

/** The overall employee-count band and an industry hint derived from a play's ICP — replaces
 * outbound-strategist.ts's old ICP_FIRMOGRAPHIC_BANDS dict (three per-play keyed literals) with
 * something computed from the play's own config so firmographicFitNotes never has to know a play
 * slug. `employeeRanges` entries are "min,max" strings (Apollo's own format); the band is the
 * widest span across all of them. */
export function firmographicBandFromIcp(icp: OutboundPlayIcp): {
  minEmployees: number | null;
  maxEmployees: number | null;
  industryHint: string;
} {
  let min: number | null = null;
  let max: number | null = null;
  for (const range of icp.employeeRanges) {
    const [rawMin, rawMax] = range.split(",").map((s) => Number(s.trim()));
    if (Number.isFinite(rawMin)) min = min === null ? rawMin : Math.min(min, rawMin);
    if (Number.isFinite(rawMax)) max = max === null ? rawMax : Math.max(max, rawMax);
  }
  const industryHint = icp.industries.length > 0 ? icp.industries.join(", ") : "this play's target ICP";
  return { minEmployees: min, maxEmployees: max, industryHint };
}

/** Routing channel implied by a score and a play's configured thresholds — same four-tier scheme
 * (EMAIL_AND_LINKEDIN / EMAIL_ONLY / WATCHLIST / DISCARDED) every play uses, just with
 * per-play cutoffs instead of the fixed 80/65/50 that used to be baked into the scoring prompt. */
export function routeByScore(total: number, thresholds: OutboundRoutingThresholds): "EMAIL_AND_LINKEDIN" | "EMAIL_ONLY" | "WATCHLIST" | "DISCARDED" {
  if (total >= thresholds.emailAndLinkedin) return "EMAIL_AND_LINKEDIN";
  if (total >= thresholds.emailOnly) return "EMAIL_ONLY";
  if (total >= thresholds.watchlist) return "WATCHLIST";
  return "DISCARDED";
}

// ---------------------------------------------------------------------------
// Scoring weights — a play's per-dimension point maxima. Stored on OutboundPlayConfig since the
// schema's introduction but never actually read by outbound-strategist.ts: the scoring prompt and
// SUBMIT_PROSPECT_INTELLIGENCE_TOOL's schema both hardcoded the six dimension maxima
// (25/20/25/15/10/5) directly, so a play editor could set scoringWeights and it would silently do
// nothing. resolveScoringWeights is what makes a play's weights real; computeWeightedTotal is what
// makes the resulting total trustworthy enough to route on.
// ---------------------------------------------------------------------------

/**
 * Resolves a play's (partial, and possibly not summing to 100) scoringWeights into the six integer
 * per-dimension maxima the scoring prompt and tool schema actually present to Claude — always
 * summing to exactly 100.
 *
 * Two things make normalisation necessary rather than optional:
 *  - `routingThresholds` (the 80/65/50 defaults, or a play's own cutoffs) are cutoffs against a
 *    0-100 scale. If one play's total tops out at 100 and another's tops out at 85 (because an
 *    admin's weights only added up to 85), the same threshold number would mean a different bar at
 *    each play — routing would silently get easier or harder purely from an arithmetic mistake in
 *    the play editor, not from an intentional change to the play's bar.
 *  - The Outbound CRO agent and any future cross-play comparison reads `scoring.total` as a
 *    percentage-like figure comparable across plays. That comparison is only meaningful if every
 *    play's total is actually out of the same 100.
 *
 * A dimension left unset in the play's config falls back to DEFAULT_SCORING_WEIGHTS before
 * normalising — so setting just one dimension (e.g. raising `timing`) reweights relative to the
 * other five defaults, rather than requiring every field to be filled in. Any dimension set to a
 * negative or non-finite number is treated as unset (same fallback) rather than propagating a bad
 * value into the prompt.
 *
 * Uses largest-remainder rounding (scale each weight to its exact 0-100 share, floor it, then hand
 * the few leftover points to whichever dimensions lost the most to flooring) rather than rounding
 * each dimension independently — independent rounding can land the six maxima on 99 or 101 instead
 * of exactly 100 depending on the inputs; largest-remainder always lands on exactly 100 (or exactly
 * matches DEFAULT_SCORING_WEIGHTS's own 100 when every dimension is left at its default).
 */
export function resolveScoringWeights(weights: OutboundScoringWeights | undefined | null): Record<ScoringDimension, number> {
  const merged: Record<ScoringDimension, number> = { ...DEFAULT_SCORING_WEIGHTS };
  for (const dim of SCORING_DIMENSIONS) {
    const v = weights?.[dim];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) merged[dim] = v;
  }

  const sum = SCORING_DIMENSIONS.reduce((s, d) => s + merged[d], 0);
  if (sum <= 0) {
    // Every weight resolved to 0 (e.g. a play explicitly zeroed out all six) — fall back to the
    // default split rather than dividing by zero or asking Claude to score six 0-point dimensions.
    return { ...DEFAULT_SCORING_WEIGHTS };
  }

  const scaled = SCORING_DIMENSIONS.map((dim) => {
    const exact = (merged[dim] / sum) * 100;
    const floor = Math.floor(exact);
    return { dim, floor, remainder: exact - floor };
  });

  const result = Object.fromEntries(scaled.map(({ dim, floor }) => [dim, floor])) as Record<ScoringDimension, number>;
  let remaining = 100 - scaled.reduce((s, x) => s + x.floor, 0);
  const byRemainderDesc = [...scaled].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; remaining > 0 && i < byRemainderDesc.length; i++, remaining--) {
    result[byRemainderDesc[i].dim] += 1;
  }
  return result;
}

/**
 * Recomputes the 0-100 composite total from a scored prospect's six raw dimension scores, clamping
 * each one to its resolved weight (`resolveScoringWeights`'s output) first — Claude is told each
 * dimension's maximum in the prompt and the tool schema's description, but nothing in a JSON
 * schema enforces an integer property's upper bound (this codebase's tool schemas rely on
 * description text for bounds throughout, not the `maximum` keyword — see lib/content/article.ts's
 * strictSchema), so a dimension score above its max is possible and must not inflate the total used
 * for routing. `scores[dim]` missing or non-numeric is treated as 0 rather than thrown on, since a
 * malformed tool call should degrade the prospect's score, not crash the run.
 */
export function computeWeightedTotal(
  scores: Partial<Record<ScoringDimension, number>>,
  weights: Record<ScoringDimension, number>,
): number {
  let total = 0;
  for (const dim of SCORING_DIMENSIONS) {
    const raw = Number(scores[dim]);
    const clamped = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 0), weights[dim]) : 0;
    total += clamped;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Campaign resolution — replaces outbound-email.ts's old CAMPAIGN_MAP and outbound-linkedin.ts's
// old AIMFOX_CAMPAIGN_MAP (both per-play-slug literals). A play's campaign now comes from its own
// config, never a name derived from the play's slug.
// ---------------------------------------------------------------------------

export type CampaignResolutionPlan =
  /** The play editor's dropdown already resolved this to a live id — nothing to look up. */
  | { mode: "id"; campaignId: string; campaignName: string }
  /** Only a name is on file (typed in before the integration was connected) — the caller must
   * look it up against the workspace's live campaign list. */
  | { mode: "lookup"; targetName: string }
  /** Neither is set — the play has no campaign configured for this channel at all. */
  | { mode: "unconfigured" };

/** Pure decision, no network: given a play's stored campaign id/name for one channel, decides
 * whether a live lookup is even needed. Shared by outbound-email.ts (Instantly) and
 * outbound-linkedin.ts (Aimfox) — same three-way decision either way. */
export function planCampaignResolution(campaignId: string | undefined, campaignName: string | undefined): CampaignResolutionPlan {
  if (campaignId) return { mode: "id", campaignId, campaignName: campaignName ?? campaignId };
  if (campaignName) return { mode: "lookup", targetName: campaignName };
  return { mode: "unconfigured" };
}

// ---------------------------------------------------------------------------
// Scout sourcing — pure selection logic pulled out of outbound-scout.ts so the reveal cap,
// exclusion filter, and pipeline dedupe can be unit tested without a live Apollo key or database.
// ---------------------------------------------------------------------------

/** Which of Apollo's matched people are eligible to have their email revealed this run: not
 * excluded by the play's rules, and within the per-run reveal cap. Order-preserving — the cap
 * takes Apollo's own ranking, it doesn't re-sort. */
export function selectPeopleToReveal<T extends { organization?: unknown }>(
  people: T[],
  opts: { exclusions: string[]; cap: number },
): { toReveal: T[]; excludedByRules: number } {
  const eligible = people.filter(
    (p) => !matchesExclusion(p.organization as { name?: unknown; primary_domain?: unknown; website_url?: unknown } | undefined, opts.exclusions),
  );
  return { toReveal: eligible.slice(0, Math.max(0, opts.cap)), excludedByRules: people.length - eligible.length };
}

/** Drops any sourced prospect whose email is already in this workspace's pipeline — the guarantee
 * that Scout never re-adds someone already being worked. Case-insensitive; a prospect with no
 * email at all is dropped too (OutboundProspect.email is required, so it could never be saved). */
export function dedupeNewProspects<T extends { email?: unknown }>(prospects: T[], existingEmails: Set<string>): T[] {
  return prospects.filter((p) => {
    const email = typeof p.email === "string" ? p.email.toLowerCase() : "";
    return email.length > 0 && !existingEmails.has(email);
  });
}
