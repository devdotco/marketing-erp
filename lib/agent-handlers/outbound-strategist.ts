import type { AgentHandler } from "./index";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { toolInputFrom } from "@/lib/ai/extract";
import { createMessage } from "@/lib/ai/messages";
import { resolveInputs, num } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { strictSchema } from "@/lib/content/article";
import { apolloEnrichOrganization, apolloMatchPerson, apolloOrganizationJobPostings } from "@/lib/integrations/apollo";
import { parsePlayConfig, firmographicBandFromIcp, routeByScore, type OutboundPlayConfig } from "./outbound-play-config";

// ---------------------------------------------------------------------------
// Apollo enrichment — pure planning logic (freshness, dedupe, cap selection).
// No network or DB here so this is unit-testable without a live key —
// see test/content.test.ts.
// ---------------------------------------------------------------------------

/** One prospect's current enrichment state, as seen before this run does any fetching. */
export interface ApolloLookupCandidate {
  /** Lowercased prospect email — also the key the plan reports skips against. */
  email: string;
  /** Lowercased company domain, if the prospect record has one. */
  domain?: string;
  /** ISO timestamp of the last successful organization enrichment for this domain, if any. */
  orgFetchedAt?: string | null;
  /** ISO timestamp of the last successful person enrichment for this email, if any. */
  personFetchedAt?: string | null;
}

export type ApolloSkipReason = "not_connected" | "cap_reached" | "fresh";

export interface ApolloLookupPlan {
  /** Distinct, lowercased domains to call organization enrichment for — one entry per domain even
   * when several prospects share it, so the credit is spent once and the result reused. */
  domainsToFetch: string[];
  /** Prospect emails to call person enrichment for. */
  emailsToFetch: string[];
  skipped: Array<{ email: string; domain?: string; reason: ApolloSkipReason }>;
}

/** True when cached data is missing or older than the freshness window. */
export function isApolloDataStale(
  fetchedAt: string | null | undefined,
  freshnessDays: number,
  now: Date = new Date(),
): boolean {
  if (!fetchedAt) return true;
  const fetchedMs = Date.parse(fetchedAt);
  if (Number.isNaN(fetchedMs)) return true;
  return now.getTime() - fetchedMs > freshnessDays * 24 * 60 * 60 * 1000;
}

/**
 * Decides which Apollo calls this run is allowed to make: nothing at all when Apollo isn't
 * connected, otherwise only for data that's missing or stale, deduped by domain, and capped at
 * `maxLookups` total calls (an org lookup already queued for a domain never spends a second slot
 * for a later prospect at the same company).
 */
export function planApolloLookups(
  candidates: ApolloLookupCandidate[],
  opts: { connected: boolean; freshnessDays: number; maxLookups: number; now?: Date },
): ApolloLookupPlan {
  const now = opts.now ?? new Date();
  const plan: ApolloLookupPlan = { domainsToFetch: [], emailsToFetch: [], skipped: [] };

  if (!opts.connected) {
    for (const c of candidates) plan.skipped.push({ email: c.email, domain: c.domain, reason: "not_connected" });
    return plan;
  }

  const queuedDomains = new Set<string>();
  let budget = Math.max(0, opts.maxLookups);

  for (const c of candidates) {
    const domain = c.domain?.trim().toLowerCase() || undefined;
    const needsOrg = !!domain && isApolloDataStale(c.orgFetchedAt, opts.freshnessDays, now);
    const needsPerson = isApolloDataStale(c.personFetchedAt, opts.freshnessDays, now);
    let anySkippedForCap = false;

    if (needsOrg && domain) {
      if (queuedDomains.has(domain)) {
        // Already queued by an earlier prospect at the same company — reused, no extra credit.
      } else if (budget > 0) {
        plan.domainsToFetch.push(domain);
        queuedDomains.add(domain);
        budget -= 1;
      } else {
        anySkippedForCap = true;
      }
    }

    if (needsPerson) {
      if (budget > 0) {
        plan.emailsToFetch.push(c.email);
        budget -= 1;
      } else {
        anySkippedForCap = true;
      }
    }

    if (anySkippedForCap) {
      plan.skipped.push({ email: c.email, domain, reason: "cap_reached" });
    } else if (!needsOrg && !needsPerson) {
      plan.skipped.push({ email: c.email, domain, reason: "fresh" });
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// ICP firmographic bands — derived from the play's own stored config, not a hardcoded per-slug
// table. See the outbound-play-config module's firmographicBandFromIcp for how "employeeRanges"
// strings become one min/max band.
// ---------------------------------------------------------------------------

/** Pure: turns one org's Apollo firmographics into plain-English notes for the scoring prompt.
 * Never invents a number — a note only appears for a field Apollo actually returned. `band` comes
 * from firmographicBandFromIcp(playConfig.icp) — pass a fallback ({ minEmployees: null,
 * maxEmployees: null, industryHint: "this play's target ICP" }) when no band is known. */
export function firmographicFitNotes(
  band: { minEmployees: number | null; maxEmployees: number | null; industryHint: string },
  org: { employeeCount?: number | null; industry?: string | null } | null | undefined,
): string[] {
  const notes: string[] = [];

  if (!org || (org.employeeCount == null && !org.industry)) {
    notes.push("No Apollo firmographic data available for this company — firmographic fit must be inferred from the prospect record alone, and dataQuality should reflect that.");
    return notes;
  }

  if (typeof org.employeeCount === "number" && band.minEmployees !== null && band.maxEmployees !== null) {
    if (org.employeeCount < band.minEmployees) {
      notes.push(`Apollo reports ${org.employeeCount} employees — below this play's ${band.minEmployees}-${band.maxEmployees} ICP band.`);
    } else if (org.employeeCount > band.maxEmployees) {
      notes.push(`Apollo reports ${org.employeeCount} employees — above this play's ${band.minEmployees}-${band.maxEmployees} ICP band.`);
    } else {
      notes.push(`Apollo reports ${org.employeeCount} employees — within this play's ${band.minEmployees}-${band.maxEmployees} ICP band.`);
    }
  } else if (typeof org.employeeCount === "number") {
    notes.push(`Apollo reports ${org.employeeCount} employees — this play has no employee-range ICP filter configured to compare against.`);
  }
  if (org.industry) {
    notes.push(`Apollo industry: "${org.industry}" — this play targets a ${band.industryHint}.`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Apollo response shapes and mapping — the network-facing half, exercised manually rather than
// unit tested (same convention as lead-enrichment.ts and outbound-scout.ts).
// ---------------------------------------------------------------------------

export interface RawApolloOrg {
  id?: string;
  primary_domain?: string;
  industry?: string;
  keywords?: string[];
  estimated_num_employees?: number;
  annual_revenue_printed?: string;
  total_funding?: number;
  total_funding_printed?: string;
  latest_funding_stage?: string;
  latest_funding_round_date?: string;
  technology_names?: string[];
  founded_year?: number;
  city?: string;
  state?: string;
  country?: string;
}

export interface RawApolloPerson {
  title?: string;
  seniority?: string;
  departments?: string[];
  employment_history?: Array<{ organization_name?: string; title?: string; start_date?: string; end_date?: string; current?: boolean }>;
  organization?: { id?: string };
}

export interface RawApolloJobPosting {
  title?: string;
}

export interface ApolloOrgEnrichment {
  id?: string;
  domain: string;
  industry?: string;
  employeeCount?: number;
  revenueRange?: string;
  fundingStage?: string;
  totalFundingUsd?: number;
  latestFundingRoundDate?: string;
  technologies?: string[];
  keywords?: string[];
  foundedYear?: number;
  location?: string;
  fetchedAt: string;
}

export interface ApolloPersonEnrichment {
  title?: string;
  seniority?: string;
  departments?: string[];
  recentEmployment?: string[];
  fetchedAt: string;
}

export interface ApolloJobPostingsEnrichment {
  count: number;
  titles: string[];
  fetchedAt: string;
}

export interface StoredApolloEnrichment {
  org?: ApolloOrgEnrichment;
  person?: ApolloPersonEnrichment;
  jobPostings?: ApolloJobPostingsEnrichment;
}

export function mapApolloOrg(raw: RawApolloOrg | undefined, domain: string, now: string): ApolloOrgEnrichment | null {
  if (!raw) return null;
  return {
    id: raw.id,
    domain: raw.primary_domain ?? domain,
    industry: raw.industry,
    employeeCount: raw.estimated_num_employees,
    revenueRange: raw.annual_revenue_printed,
    fundingStage: raw.latest_funding_stage,
    totalFundingUsd: raw.total_funding,
    latestFundingRoundDate: raw.latest_funding_round_date,
    technologies: raw.technology_names?.slice(0, 10),
    keywords: raw.keywords?.slice(0, 10),
    foundedYear: raw.founded_year,
    location: [raw.city, raw.state, raw.country].filter(Boolean).join(", ") || undefined,
    fetchedAt: now,
  };
}

export function mapApolloPerson(raw: RawApolloPerson | undefined, now: string): ApolloPersonEnrichment | null {
  if (!raw) return null;
  return {
    title: raw.title,
    seniority: raw.seniority,
    departments: raw.departments,
    recentEmployment: (raw.employment_history ?? [])
      .slice(0, 3)
      .map((e) => `${e.title ?? "Unknown title"} at ${e.organization_name ?? "unknown company"}${e.current ? " (current)" : ""}`),
    fetchedAt: now,
  };
}

export function mapApolloJobPostings(raw: RawApolloJobPosting[] | undefined, now: string): ApolloJobPostingsEnrichment | null {
  if (!raw) return null;
  return {
    count: raw.length,
    titles: raw.slice(0, 10).map((j) => j.title ?? "Untitled role").filter(Boolean),
    fetchedAt: now,
  };
}

/**
 * The "verified SEC filing" half of the scoring prompt, built from OutboundProspect.sourceSignal.
 *
 * Returns null for every prospect sourced by ICP search (sourceSignal is null there), so the
 * prompt is byte-identical to what it was before capital-raise sourcing existed unless a real
 * filing is on the record. When there is one, the facts are presented the same way the Apollo
 * block presents its own: named source, explicitly citable, and explicitly not to be extended —
 * a Form D says what was offered and sold, and nothing about why or from whom, so the model is
 * told where the record stops.
 */
export function buildSourceSignalBlock(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const signal = raw as Record<string, unknown>;
  if (signal.source !== "sec_form_d") return null;

  const filing = (signal.secFormD ?? {}) as Record<string, unknown>;
  const primary = typeof signal.primarySignal === "string" ? signal.primarySignal : "";
  const additional = Array.isArray(signal.additionalSignals)
    ? signal.additionalSignals.filter((s): s is string => typeof s === "string")
    : [];

  const lines = [
    "Verified SEC EDGAR data for this prospect's company (public record — cite these in apolloFactsUsed prefixed \"per SEC Form D filing\" when you use them, and never contradict or extend them):",
    primary ? `Filing: ${primary}` : "Filing: an SEC Form D was filed by this company.",
  ];
  if (filing.filedAt) lines.push(`Filed: ${String(filing.filedAt)}`);
  if (filing.offeringAmount !== null && filing.offeringAmount !== undefined) {
    lines.push(`Total offering amount (USD): ${String(filing.offeringAmount)}`);
  }
  if (filing.amountSold !== null && filing.amountSold !== undefined) {
    lines.push(`Amount sold to date (USD): ${String(filing.amountSold)}`);
  }
  if (filing.industryGroup) lines.push(`Form D industry group: ${String(filing.industryGroup)}`);
  if (additional.length > 0) lines.push(`Also on the filing: ${additional.join("; ")}`);
  if (filing.url) lines.push(`Source: ${String(filing.url)}`);
  lines.push(
    "This is a dated, public funding event and is the reason this prospect was sourced — weigh it in the timing and observable-signal scores. A Form D states what is being offered and what has been sold; it does NOT state the investors, the valuation, the round name (Seed/Series A/etc.), or what the money is for. Do not infer any of those — put any such claim in inferredAssumptions.",
  );
  return lines.join("\n");
}

function normalizeProspects(raw: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && !!(p as Record<string, unknown>).email);
}

// ---------------------------------------------------------------------------
// Scoring — one strict tool call per prospect, grounded in whatever Apollo data is on hand.
// ---------------------------------------------------------------------------

const SUBMIT_PROSPECT_INTELLIGENCE_TOOL_NAME = "submit_prospect_intelligence";

const CHANNELS = ["EMAIL_AND_LINKEDIN", "EMAIL_ONLY", "WATCHLIST", "DISCARDED"] as const;
type Channel = (typeof CHANNELS)[number];

export const SUBMIT_PROSPECT_INTELLIGENCE_TOOL = {
  name: SUBMIT_PROSPECT_INTELLIGENCE_TOOL_NAME,
  strict: true,
  description: "Submit this prospect's ICP score and Prospect Intelligence Object.",
  input_schema: strictSchema({
    type: "object",
    required: ["scoring", "intelligence"],
    properties: {
      scoring: {
        type: "object",
        required: ["total", "signal", "serviceFit", "firmographic", "persona", "timing", "dataQuality", "routing", "scoringRationale"],
        properties: {
          total: { type: "integer", description: "0-100 composite score — the sum of the six dimensions below." },
          signal: { type: "integer", description: "0-25: observable pain or trigger signal." },
          serviceFit: { type: "integer", description: "0-20: fit with this play's service offer." },
          firmographic: { type: "integer", description: "0-25: company size, industry, revenue, location vs. the play's ICP." },
          persona: { type: "integer", description: "0-15: title/seniority/department fit." },
          timing: { type: "integer", description: "0-10: funding recency, hiring signals, headcount growth." },
          dataQuality: { type: "integer", description: "0-5: how much of this score rests on verified data vs. inference." },
          routing: { type: "string", enum: [...CHANNELS], description: "80+: EMAIL_AND_LINKEDIN. 65-79: EMAIL_ONLY. 50-64: WATCHLIST. <50: DISCARDED." },
          scoringRationale: { type: "string", description: "2-3 sentences explaining the score." },
        },
      },
      intelligence: {
        type: "object",
        required: ["painHypothesis", "primarySignal", "bestOffer", "messagingAngle", "avoid", "proofPoints", "companyContext", "apolloFactsUsed", "inferredAssumptions"],
        properties: {
          painHypothesis: { type: "string", description: "1 sentence: the core pain this company likely has." },
          primarySignal: { type: "string", description: "The single strongest signal that makes this prospect worth contacting." },
          bestOffer: { type: "string", description: "The specific part of this play's service offer that maps to their situation." },
          messagingAngle: { type: "string", description: "The angle that will resonate — NOT generic outsourcing." },
          avoid: { type: "string", description: "What NOT to say in outreach to this prospect." },
          proofPoints: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            description: "1-2 social proof points that would resonate with this type of buyer.",
          },
          companyContext: { type: "string", description: "Compact 1-sentence context about the company for agent memory." },
          apolloFactsUsed: {
            type: "array",
            minItems: 0,
            items: { type: "string" },
            description:
              "Specific facts pulled from the verified source blocks supplied above — Apollo data (e.g. 'Series B, per Apollo funding data', '340 employees per Apollo org enrichment', '4 open Senior Engineer postings per Apollo job postings') and, when an SEC filing block is present, facts from it prefixed 'per SEC Form D filing' (e.g. 'per SEC Form D filing, $25M offering with $1M sold as of 2026-09-18') — that grounded primarySignal, companyContext, or a proof point. Empty array if no verified source data was supplied — never invent an entry here.",
          },
          inferredAssumptions: {
            type: "array",
            minItems: 0,
            items: { type: "string" },
            description: "Anything asserted above that is inference, not a fact from Apollo or the prospect record.",
          },
        },
      },
    },
  }),
} as Anthropic.Tool;

interface ScoredProspect {
  scoring: {
    total: number;
    signal: number;
    serviceFit: number;
    firmographic: number;
    persona: number;
    timing: number;
    dataQuality: number;
    routing: Channel;
    scoringRationale: string;
  };
  intelligence: {
    painHypothesis: string;
    primarySignal: string;
    bestOffer: string;
    messagingAngle: string;
    avoid: string;
    proofPoints: string[];
    companyContext: string;
    apolloFactsUsed: string[];
    inferredAssumptions: string[];
  };
}

async function scoreProspect(
  client: Anthropic,
  prospect: Record<string, unknown>,
  play: { name: string; config: OutboundPlayConfig },
  apollo: { org: ApolloOrgEnrichment | null; person: ApolloPersonEnrichment | null; jobPostings: ApolloJobPostingsEnrichment | null },
): Promise<{ scored: ScoredProspect; costUsd: number }> {
  // Destructured once, rather than reading each field off play.config inline below — not just
  // style: test/content.test.ts's fleet-wide handler/metadata key-parity guard regexes this file's
  // source for accesses on the *other* `config` object (outboundStrategistHandler's own
  // resolveInputs(run) result, a screen down) by literal text, so writing play.config's fields out
  // inline reads as a false hit against that unrelated object.
  const { icp, routingThresholds: thresholds, serviceOffer, proofPoints } = play.config;
  const band = firmographicBandFromIcp(icp);
  const firmographicNotes = firmographicFitNotes(band, apollo.org);

  const apolloBlock = apollo.org || apollo.person || apollo.jobPostings
    ? [
        "Verified Apollo.io data for this prospect (cite these in apolloFactsUsed when you use them — never contradict or extend them):",
        apollo.org
          ? `Organization (fetched ${apollo.org.fetchedAt}): industry=${apollo.org.industry ?? "unknown"}, employees=${apollo.org.employeeCount ?? "unknown"}, revenue=${apollo.org.revenueRange ?? "unknown"}, fundingStage=${apollo.org.fundingStage ?? "unknown"}, totalFunding=${apollo.org.totalFundingUsd ?? "unknown"}, latestFundingRoundDate=${apollo.org.latestFundingRoundDate ?? "unknown"}, technologies=${(apollo.org.technologies ?? []).join(", ") || "unknown"}, founded=${apollo.org.foundedYear ?? "unknown"}, location=${apollo.org.location ?? "unknown"}.`
          : "Organization: not available from Apollo.",
        apollo.person
          ? `Person (fetched ${apollo.person.fetchedAt}): title=${apollo.person.title ?? "unknown"}, seniority=${apollo.person.seniority ?? "unknown"}, departments=${(apollo.person.departments ?? []).join(", ") || "unknown"}, recentEmployment=${(apollo.person.recentEmployment ?? []).join("; ") || "unknown"}.`
          : "Person: not available from Apollo.",
        apollo.jobPostings
          ? `Job postings (fetched ${apollo.jobPostings.fetchedAt}): ${apollo.jobPostings.count} open roles indexed, including: ${apollo.jobPostings.titles.join(", ") || "none listed"}.`
          : "Job postings: not available from Apollo.",
        ...firmographicNotes,
      ].join("\n")
    : "No Apollo.io data is available for this prospect (not connected, or nothing fetched this run). Score and write the Intelligence Object from the prospect record alone — do not fabricate funding, tech stack, or hiring facts, and list every such claim in intelligence.inferredAssumptions instead of apolloFactsUsed.";

  // The event this prospect was SOURCED on, when there was one. Presented as its own verified
  // block rather than folded into the Apollo one: it comes from a different source (a public SEC
  // filing), and the whole reason capital-raise sourcing exists is that this fact should drive the
  // timing and signal scores. Absent for ICP-search prospects, which is most of them.
  const sourceSignalBlock = buildSourceSignalBlock(prospect.sourceSignal);

  const systemPrompt = `You are an ICP scoring specialist for the outbound play "${play.name}".
${serviceOffer ? `\nWhat is being sold: ${serviceOffer}` : ""}
${proofPoints.length ? `\nProof points available to reference: ${proofPoints.join(" | ")}` : ""}

Your job is to score a single prospect against this play's ICP criteria and generate a Prospect Intelligence Object used by the email and LinkedIn outreach agents.

Score the prospect across exactly these six dimensions (max points shown):
1. Observable pain / trigger signal: 0-25 points
2. Service fit: 0-20 points
3. Firmographic fit: 0-25 points
4. Persona fit: 0-15 points
5. Timing indicators: 0-10 points
6. Data quality: 0-5 points

Channel routing rules for this play (the total below decides the actual routing — these are so your rationale is consistent with it):
- ${thresholds.emailAndLinkedin}+: EMAIL_AND_LINKEDIN
- ${thresholds.emailOnly}-${thresholds.emailAndLinkedin - 1}: EMAIL_ONLY
- ${thresholds.watchlist}-${thresholds.emailOnly - 1}: WATCHLIST
- <${thresholds.watchlist}: DISCARDED

Never fabricate a funding round, tech-stack entry, headcount figure, or hiring signal. Every fact in apolloFactsUsed must trace back to the Apollo data block or the SEC filing block you were given; anything else you assert belongs in inferredAssumptions instead. Call submit_prospect_intelligence exactly once with the complete result — no other text.`;

  const userPrompt = `Score this prospect for play "${play.name}" and generate their Prospect Intelligence Object.

Prospect data:
${JSON.stringify(prospect, null, 2)}

${apolloBlock}${sourceSignalBlock ? `\n\n${sourceSignalBlock}` : ""}`;

  const message = await createMessage(client, {
    model: MODELS.standard,
    max_tokens: 2048,
    system: systemPrompt,
    tools: [SUBMIT_PROSPECT_INTELLIGENCE_TOOL],
    tool_choice: { type: "tool", name: SUBMIT_PROSPECT_INTELLIGENCE_TOOL_NAME },
    messages: [{ role: "user", content: userPrompt }],
  });

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);
  const scored = toolInputFrom<ScoredProspect>(message, SUBMIT_PROSPECT_INTELLIGENCE_TOOL_NAME);
  if (!scored) throw new Error("The Strategist did not submit a score for this prospect.");

  return { scored, costUsd };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const outboundStrategistHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  const playSlug = (input.playSlug ?? config.playSlug) as string | undefined;
  if (!playSlug) {
    return {
      output: { error: "No outbound play selected. Choose a play in Settings → Outbound Engine, or pass playSlug when triggering this run." },
      costUsd: 0,
    };
  }

  // Fetch the OutboundPlay for this workspace + slug — never auto-created with a guessed name
  // (that's how the three hardcoded Dev.co plays used to leak into every workspace that ran this agent before a play
  // existed). A workspace must create its play on the Outbound Engine page first.
  const play = await prisma.outboundPlay.findUnique({
    where: { workspaceId_slug: { workspaceId: run.agentConfig.workspaceId, slug: playSlug } },
  });
  if (!play) {
    return {
      output: {
        error: `No outbound play "${playSlug}" exists for this workspace.`,
        hint: "Create it on the Outbound Engine page (/outbound), then run this again.",
      },
      costUsd: 0,
    };
  }
  const playConfig = parsePlayConfig(play.config);

  // "prospects" (batch, from Outbound Scout's own output array) and "prospect" (single) are read
  // straight off the raw run input — only "prospect" is a declared, saved-config-backed form field
  // (see lib/agent-metadata.ts); a batch handoff is always a one-off run input, never a saved default.
  let rawProspects = normalizeProspects(input.prospects ?? input.prospect ?? config.prospect);

  // "prospectIds" — a batch of already-persisted OutboundProspect ids, handed over by chaining.ts
  // when Outbound Scout auto-advances into this run (see lib/agent-handlers/chaining.ts). Loaded
  // and reshaped into the same raw-prospect record shape the rest of this handler already expects,
  // so scoring/upsert below runs identically regardless of which path prospects arrived by.
  if (rawProspects.length === 0 && Array.isArray(input.prospectIds) && input.prospectIds.length > 0) {
    const ids = (input.prospectIds as unknown[]).filter((v): v is string => typeof v === "string");
    const rows = await prisma.outboundProspect.findMany({ where: { id: { in: ids }, workspaceId: run.agentConfig.workspaceId } });
    rawProspects = rows.map((r) => ({
      firstName: r.firstName,
      lastName: r.lastName ?? undefined,
      email: r.email,
      linkedInUrl: r.linkedInUrl ?? undefined,
      title: r.title ?? undefined,
      company: r.company,
      companyDomain: r.companyDomain ?? undefined,
      // Carried through so a prospect sourced on a discrete event (today: an SEC Form D filing)
      // reaches scoring with that event intact. Without this the strongest, most verifiable fact
      // about a capital-raise prospect is dropped at the Scout/Strategist boundary, and the
      // scoring prompt correctly refuses to assert a funding round it was never given.
      sourceSignal: r.sourceSignal ?? undefined,
    }));
  }

  const maxApolloLookups = num(config, "maxApolloLookups", 25, { min: 0, max: 200 });
  const enrichmentFreshnessDays = num(config, "enrichmentFreshnessDays", 30, { min: 1, max: 365 });

  if (rawProspects.length === 0) {
    const output = { error: "No prospect(s) provided in run.input.prospect / run.input.prospects / run.input.prospectIds", playSlug };
    return { output, costUsd: 0 };
  }

  // ── Apollo: connect check + freshness/dedupe/cap plan ──────────────────────
  const apolloIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "APOLLO" } },
  });
  const apolloApiKey = apolloIntegration
    ? (await decryptCredentials<{ apiKey: string }>(apolloIntegration.encryptedCredentials)).apiKey
    : null;

  const emails = [...new Set(rawProspects.map((p) => String(p.email as string).toLowerCase()))];
  const existingRows = await prisma.outboundProspect.findMany({
    where: { workspaceId: run.agentConfig.workspaceId, email: { in: emails } },
  });
  const existingByEmail = new Map(existingRows.map((r) => [r.email, r]));

  const candidates: ApolloLookupCandidate[] = rawProspects.map((p) => {
    const email = String(p.email as string).toLowerCase();
    const stored = (existingByEmail.get(email)?.apolloEnrichment ?? null) as StoredApolloEnrichment | null;
    return {
      email,
      domain: (p.companyDomain as string | undefined)?.trim().toLowerCase() || undefined,
      orgFetchedAt: stored?.org?.fetchedAt ?? null,
      personFetchedAt: stored?.person?.fetchedAt ?? null,
    };
  });

  const plan = planApolloLookups(candidates, {
    connected: !!apolloApiKey,
    freshnessDays: enrichmentFreshnessDays,
    maxLookups: maxApolloLookups,
  });

  // ── Fetch organizations (deduped by domain) ─────────────────────────────────
  const orgByDomain = new Map<string, ApolloOrgEnrichment | null>();
  const jobPostingsByDomain = new Map<string, ApolloJobPostingsEnrichment | null>();
  const personByEmailFetched = new Map<string, ApolloPersonEnrichment | null>();
  let apolloBudgetSpent = 0;

  if (apolloApiKey) {
    for (const domain of plan.domainsToFetch) {
      const now = new Date().toISOString();
      try {
        const res = await apolloEnrichOrganization(apolloApiKey, domain);
        if (res.status === 401 || res.status === 403) {
          throw new AgentInputError(
            `Apollo.io rejected the organization enrichment call for ${domain} (HTTP ${res.status}).`,
            "The Apollo API key in Settings → Integrations → Apollo.io is invalid, revoked, or out of credits — check it there.",
            "apollo_auth_failed",
          );
        }
        apolloBudgetSpent += 1;
        if (!res.ok) {
          orgByDomain.set(domain, null);
          continue;
        }
        const json = (await res.json()) as { organization?: RawApolloOrg };
        const org = mapApolloOrg(json.organization, domain, now);
        orgByDomain.set(domain, org);

        // Hiring signal, bundled onto the same domain — only when we just refreshed the org data
        // and the run still has budget for it.
        if (org?.id && apolloBudgetSpent < maxApolloLookups) {
          try {
            const jpRes = await apolloOrganizationJobPostings(apolloApiKey, org.id);
            apolloBudgetSpent += 1;
            if (jpRes.ok) {
              const jpJson = (await jpRes.json()) as { job_postings?: RawApolloJobPosting[] };
              jobPostingsByDomain.set(domain, mapApolloJobPostings(jpJson.job_postings, now));
            } else {
              jobPostingsByDomain.set(domain, null);
            }
          } catch {
            // Per-prospect isolation: a job-postings miss doesn't invalidate the org enrichment.
            jobPostingsByDomain.set(domain, null);
          }
        }
      } catch (err) {
        if (err instanceof AgentInputError) throw err;
        // Network blip or no data for this one domain — record it and keep going; a single
        // company failing to enrich must not stop the rest of the run.
        orgByDomain.set(domain, null);
      }
    }

    // ── Fetch people ───────────────────────────────────────────────────────
    for (const email of plan.emailsToFetch) {
      const now = new Date().toISOString();
      try {
        const res = await apolloMatchPerson(apolloApiKey, { email });
        if (res.status === 401 || res.status === 403) {
          throw new AgentInputError(
            `Apollo.io rejected the person enrichment call for ${email} (HTTP ${res.status}).`,
            "The Apollo API key in Settings → Integrations → Apollo.io is invalid, revoked, or out of credits — check it there.",
            "apollo_auth_failed",
          );
        }
        apolloBudgetSpent += 1;
        if (!res.ok) continue;
        const json = (await res.json()) as { person?: RawApolloPerson };
        personByEmailFetched.set(email, mapApolloPerson(json.person, now));
      } catch (err) {
        if (err instanceof AgentInputError) throw err;
        personByEmailFetched.set(email, null);
      }
    }
  }

  // ── Score + persist each prospect ───────────────────────────────────────────
  const results: Record<string, unknown>[] = [];
  let costUsd = 0;

  for (const prospect of rawProspects) {
    const email = String(prospect.email as string).toLowerCase();
    const domain = (prospect.companyDomain as string | undefined)?.trim().toLowerCase();
    const stored = (existingByEmail.get(email)?.apolloEnrichment ?? null) as StoredApolloEnrichment | null;

    const org = (domain ? orgByDomain.get(domain) : undefined) ?? stored?.org ?? null;
    const person = personByEmailFetched.get(email) ?? stored?.person ?? null;
    const jobPostings = (domain ? jobPostingsByDomain.get(domain) : undefined) ?? stored?.jobPostings ?? null;

    const apolloEnrichment: StoredApolloEnrichment = {
      ...(org ? { org } : stored?.org ? { org: stored.org } : {}),
      ...(person ? { person } : stored?.person ? { person: stored.person } : {}),
      ...(jobPostings ? { jobPostings } : stored?.jobPostings ? { jobPostings: stored.jobPostings } : {}),
    };

    const { scored, costUsd: scoreCost } = await scoreProspect(client, prospect, { name: play.name, config: playConfig }, { org, person, jobPostings });
    costUsd += scoreCost;

    const total = scored.scoring.total;
    // Routing is recomputed from the total against this play's own configured thresholds rather
    // than trusting Claude's own `scoring.routing` pick verbatim (still requested — CHANNELS is in
    // the tool schema's enum, so a malformed response is caught at parse time — but the thresholds
    // are the ground truth for what actually happens, so a play's configured cutoffs always win).
    const routing = routeByScore(total, playConfig.routingThresholds);

    const dbProspect = await prisma.outboundProspect.upsert({
      where: { workspaceId_email: { workspaceId: run.agentConfig.workspaceId, email } },
      create: {
        workspaceId: run.agentConfig.workspaceId,
        playId: play.id,
        firstName: (prospect.firstName as string) ?? "",
        lastName: prospect.lastName as string | undefined,
        email,
        linkedInUrl: prospect.linkedInUrl as string | undefined,
        title: prospect.title as string | undefined,
        company: (prospect.company as string) ?? "",
        companyDomain: prospect.companyDomain as string | undefined,
        score: total,
        channel: routing,
        intelligence: JSON.parse(JSON.stringify(scored)),
        apolloEnrichment: Object.keys(apolloEnrichment).length > 0 ? JSON.parse(JSON.stringify(apolloEnrichment)) : undefined,
      },
      update: {
        score: total,
        channel: routing,
        intelligence: JSON.parse(JSON.stringify(scored)),
        ...(Object.keys(apolloEnrichment).length > 0 ? { apolloEnrichment: JSON.parse(JSON.stringify(apolloEnrichment)) } : {}),
      },
    });

    results.push({
      prospectId: dbProspect.id,
      prospect: {
        firstName: prospect.firstName,
        lastName: prospect.lastName,
        email,
        company: prospect.company,
        title: prospect.title,
      },
      scoring: scored.scoring,
      intelligence: scored.intelligence,
      routing,
      apolloDataUsed: !!(org || person || jobPostings),
    });
  }

  const output: Record<string, unknown> = {
    results,
    // Back-compat with the single-prospect shape this handler used before batching: when exactly
    // one prospect was submitted (the common case — Scout hands these off one at a time today),
    // also surface its fields at the top level.
    ...(results.length === 1 ? results[0] : {}),
    playSlug,
    apolloConnected: !!apolloApiKey,
    apolloLookupsUsed: apolloBudgetSpent,
    apolloLookupsSkippedForCap: plan.skipped.filter((s) => s.reason === "cap_reached").length,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
  };

  return { output, costUsd };
};
