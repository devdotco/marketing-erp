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

/**
 * Capital-raise sourcing: find the play's ICP among companies that just filed an SEC Form D.
 *
 * A Form D is due within 15 days of the first sale in a Regulation D private offering, so a fresh
 * one marks a company that has just taken money and has budget it did not have last month —
 * a dated, public, verifiable buying signal rather than an inferred one. The filing is free and
 * keyless (see lib/integrations/sec-edgar.ts); only turning its named officers into reachable
 * contacts costs anything, and that is Apollo's existing per-person reveal.
 *
 * Defaults are tuned to operating companies, because raw Form D volume is not: in a sample of 45
 * consecutive filings, 22 were pooled investment funds raising their own vehicles. Hence
 * `excludePooledInvestmentFunds` defaulting on — a play that sells to funds turns it off.
 */
export const OutboundCapitalRaiseSchema = z.object({
  /** Master switch. Off means the Scout's capital-raise mode refuses for this play, and the daily
   * tick skips it entirely. */
  enabled: z.boolean().default(false),
  /** How far back to search EDGAR by filed date. 30 days keeps a raise "recent" while covering
   * the 15-day filing deadline plus a fortnight of working the list. */
  lookbackDays: z.number().int().min(1).max(90).default(30),
  /** Smallest total offering to count as a real raise. Below ~$1M is usually a friends-and-family
   * round or a single-asset LLC with no budget to sell into. */
  minOfferingUsd: z.number().min(0).default(1_000_000),
  /** Optional ceiling — a play selling to seed-stage companies doesn't want a $500M raise. */
  maxOfferingUsd: z.number().min(0).optional(),
  /** Form D's own fixed industry taxonomy (FORM_D_INDUSTRY_GROUPS). Empty means every industry. */
  industryGroups: z.array(z.string()).default([]),
  /** Two-letter state codes matched against the issuer's business address. Empty means anywhere.
   * Separate from the ICP's `geographies`, which are Apollo's free-text location strings. */
  states: z.array(z.string()).default([]),
  /** See the schema doc — half of all Form D volume is funds raising funds. */
  excludePooledInvestmentFunds: z.boolean().default(true),
  /** Require money actually taken in (totalAmountSold > 0), not just an offering announced. */
  requireAmountSold: z.boolean().default(false),
  /** Keep only issuers that told the SEC they were formed within the last five years. */
  onlyRecentlyIncorporated: z.boolean().default(false),
  /** D/A amendments usually update a raise that closed months ago — the opposite of the timing
   * signal this mode exists for, so they're excluded unless asked for. */
  includeAmendments: z.boolean().default(false),
  /** Which signatory roles are worth an Apollo credit. Executive officers sign nearly every
   * Form D and are the decision maker in most plays; directors are a weaker but usable fallback. */
  contactRelationships: z.array(z.string()).default(["Executive Officer"]),
  /** How many named people per issuer to resolve. 2 covers the CEO-plus-one case without
   * multiplying the credit spend across a whole board. */
  contactsPerIssuer: z.number().int().min(1).max(5).default(2),
  /** Whether app/api/cron/outbound-form-d enqueues a Scout run for this play once a day. */
  dailyTick: z.boolean().default(false),
});
export type OutboundCapitalRaise = z.infer<typeof OutboundCapitalRaiseSchema>;

/** Form D's fixed industry taxonomy, exactly as the filings spell it — note "and", never "&"
 * ("Oil and Gas", "REITS and Finance", "Other Banking and Financial Services"). Offered in the
 * play editor so a workspace picks real values instead of guessing at free text that would match
 * nothing. Verified against live filings 2026-09-21. */
export const FORM_D_INDUSTRY_GROUPS = [
  "Agriculture",
  "Commercial Banking",
  "Insurance",
  "Investing",
  "Investment Banking",
  "Pooled Investment Fund",
  "Other Banking and Financial Services",
  "Business Services",
  "Coal Mining",
  "Electric Utilities",
  "Energy Conservation",
  "Environmental Services",
  "Oil and Gas",
  "Other Energy",
  "Biotechnology",
  "Health Insurance",
  "Hospitals and Physicians",
  "Pharmaceuticals",
  "Other Health Care",
  "Manufacturing",
  "Commercial",
  "Construction",
  "REITS and Finance",
  "Residential",
  "Other Real Estate",
  "Retailing",
  "Restaurants",
  "Computers",
  "Telecommunications",
  "Other Technology",
  "Airlines and Airports",
  "Lodging and Conventions",
  "Tourism and Travel Services",
  "Other Travel",
  "Other",
] as const;

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
  /** SEC Form D sourcing — see OutboundCapitalRaiseSchema. prefault, not default, for the same
   * reason `icp` uses it: a default object would skip the inner per-field defaults. */
  capitalRaise: OutboundCapitalRaiseSchema.prefault({}),
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

// ---------------------------------------------------------------------------
// Daily capital-raise tick — which plays app/api/cron/outbound-form-d should enqueue a Scout run
// for. Pure: the route does the querying, this decides. Kept here (rather than in the route) so
// the skip rules are unit-testable without a database, and so "why did my play not run last
// night" has one readable answer instead of being spread through a handler.
// ---------------------------------------------------------------------------

/** A play as the tick sees it — the row's own fields plus its parsed config. */
export interface FormDTickPlay {
  slug: string;
  name: string;
  enabled: boolean;
  config: OutboundPlayConfig;
}

export type FormDTickSkipReason =
  | "play_disabled"
  | "capital_raise_disabled"
  | "daily_tick_disabled"
  | "already_ran_today";

export interface FormDTickPlan {
  due: Array<{ playSlug: string; playName: string; maxProspects: number }>;
  skipped: Array<{ playSlug: string; reason: FormDTickSkipReason }>;
}

/**
 * Decides which plays are due a capital-raise Scout run this tick.
 *
 * `recentlyRanSlugs` is the idempotency guard and the reason this isn't just a filter: the tick is
 * driven by an external timer (a systemd unit POSTing the cron route), and a timer that fires
 * twice — a retry, a manual kick, a host that ran a catch-up after being down — must not source
 * and bill the same play twice in one day. The route passes in the play slugs that already have a
 * capital-raise Scout run inside the dedupe window, and those are skipped rather than re-queued.
 */
export function planFormDDailyTick(plays: FormDTickPlay[], recentlyRanSlugs: Set<string>): FormDTickPlan {
  const plan: FormDTickPlan = { due: [], skipped: [] };

  for (const play of plays) {
    if (!play.enabled) {
      plan.skipped.push({ playSlug: play.slug, reason: "play_disabled" });
      continue;
    }
    if (!play.config.capitalRaise.enabled) {
      plan.skipped.push({ playSlug: play.slug, reason: "capital_raise_disabled" });
      continue;
    }
    if (!play.config.capitalRaise.dailyTick) {
      plan.skipped.push({ playSlug: play.slug, reason: "daily_tick_disabled" });
      continue;
    }
    if (recentlyRanSlugs.has(play.slug)) {
      plan.skipped.push({ playSlug: play.slug, reason: "already_ran_today" });
      continue;
    }
    plan.due.push({ playSlug: play.slug, playName: play.name, maxProspects: play.config.dailySourcingCap });
  }

  return plan;
}

/**
 * Which sourcing mode a Scout run is asking for.
 *
 * The Run modal's `select` fields post their human-readable label, not a key (see
 * lib/agents/inputs.ts — a select value passes through uncoerced), and this value also arrives
 * from the daily cron and from saved agent config, where it may already be the internal key. So
 * this normalises all of them rather than comparing against one exact string in three places, and
 * anything unrecognised falls back to the mode that has always been the default.
 */
export function parseSourcingMode(raw: unknown): "icp_search" | "capital_raise" {
  if (typeof raw !== "string") return "icp_search";
  const value = raw.toLowerCase();
  if (value.includes("capital") || value.includes("form d") || value === "capital_raise") return "capital_raise";
  return "icp_search";
}
