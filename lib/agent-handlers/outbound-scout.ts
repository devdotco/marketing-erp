import { decryptCredentials } from "@/lib/crypto";
import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { apolloPeopleSearch, apolloMatchPerson } from "@/lib/integrations/apollo";

/** People that api_search matched, capped before we spend a credit revealing
 * each one's email. api_search itself has no per-record cost, but the reveal
 * step below does (one credit per person, same as unlocking a contact in
 * Apollo's own UI) — this bounds a large `maxProspects` from burning the
 * customer's whole balance in one run. */
const MAX_REVEALS_PER_RUN = 25;

const ICP_DEFINITIONS: Record<string, string> = {
  "DEV-01": `ICP: B2B SaaS or software companies, 50-500 employees, $10M-$250M estimated revenue, US or Canada.
Persona: CTO, VP Engineering, Head of Engineering, or Founder at the smaller end.
Top signals: 5+ open engineering roles, engineering headcount grew ≥10% past 12 months, recent Series A-C funding, new CTO <6 months, product launch, tech migration.
Offer: Supplemental development pod — flexible capacity without permanent headcount.
Disqualify: agencies, consulting firms, staffing companies, >1000 employees, <$5M revenue, hardware primary.`,

  "DEV-02": `ICP: Marketing agencies, creative agencies, or digital agencies, 10-200 employees, US/Canada/UK.
Persona: Owner, CEO, Founder, Head of Operations.
Top signals: new client wins published, project manager job postings (delivery demand signal), service expansion, case studies added <90 days.
Offer: Invisible white-label development partner — extend capacity, keep the client relationship.
Disqualify: dev agencies (competitors), SaaS companies, >500 employees.`,

  "DEV-03": `ICP: PE-backed portfolio companies, 100-2000 employees, any industry with visible tech debt.
Persona: CTO, CIO, VP Engineering, CEO.
Top signals: PE acquisition announced <18 months, platform company making add-on acquisitions, "digital transformation" language, legacy tech stack in job postings, cloud architect / DevOps roles open.
Offer: Development/modernization team — accelerate the transformation roadmap.
Disqualify: pure-play SaaS, <$25M revenue, no visible technical complexity.`,
};

const APOLLO_FILTERS: Record<
  string,
  {
    person_titles: string[];
    organization_num_employees_ranges: string[];
    person_locations: string[];
  }
> = {
  "DEV-01": {
    person_titles: ["CTO", "VP Engineering", "Head of Engineering", "VP of Engineering", "Founder"],
    organization_num_employees_ranges: ["51,500"],
    person_locations: ["United States", "Canada"],
  },
  "DEV-02": {
    person_titles: ["CEO", "Owner", "Founder", "Head of Operations", "Managing Director"],
    organization_num_employees_ranges: ["11,200"],
    person_locations: ["United States", "Canada", "United Kingdom"],
  },
  "DEV-03": {
    person_titles: ["CTO", "CIO", "VP Engineering", "CEO", "Chief Information Officer"],
    organization_num_employees_ranges: ["101,2000"],
    person_locations: ["United States", "Canada"],
  },
};

async function runClaudeSimulation(
  client: Anthropic,
  playSlug: string,
  icpDefinition: string,
  maxProspects: number,
  includeSignals: boolean
): Promise<{ simOutput: Record<string, unknown>; costUsd: number }> {
  const systemPrompt = `You are an outbound prospecting specialist for Dev.co, a software development agency that builds products for SaaS companies, agencies, and PE-backed companies.

Your job is to generate a list of realistic, ICP-matched prospects for a given outbound play. Each prospect must be a real-seeming but fictional company and contact with plausible firmographics, verified contact data, and at least one observable buying signal.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Generate ${maxProspects} prospect records for outbound play: ${playSlug}

ICP Definition:
${icpDefinition}

${includeSignals ? "Each prospect MUST have at least one observable buying signal listed." : ""}

Return exactly this JSON structure:
{
  "prospects": [
    {
      "firstName": "string",
      "lastName": "string",
      "email": "string (work email, use company domain)",
      "linkedInUrl": "https://linkedin.com/in/username",
      "title": "string",
      "company": "string",
      "companyDomain": "string (e.g. acmesoftware.com)",
      "employees": "50-500",
      "estimatedRevenue": "$10M-$50M",
      "industry": "string",
      "geography": "US" | "Canada" | "UK",
      "primarySignal": "string (the #1 observable buying signal)",
      "additionalSignals": ["string"],
      "dataQualityScore": 5
    }
  ],
  "playSlug": "${playSlug}",
  "sourcedAt": "ISO 8601 date string",
  "sourceNote": "Simulated prospect sourcing — connect Apollo.io in Settings → Integrations to run live sourcing"
}

Generate realistic but fictional companies and contacts. Vary industries, company sizes, and signal types.`;

  const message = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let simOutput: Record<string, unknown>;
  try {
    simOutput = jsonMatch ? JSON.parse(jsonMatch[0]) : { prospects: [], playSlug };
  } catch {
    simOutput = { prospects: [], playSlug, parseError: rawText.slice(0, 200) };
  }

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { simOutput, costUsd };
}

export const outboundScoutHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  const playSlug = (config.playSlug as string) ?? (input.playSlug as string) ?? "DEV-01";
  const maxProspects = typeof config.maxProspects === "number" ? config.maxProspects : 30;
  const includeSignals = config.includeSignals !== false;

  const icpDefinition = ICP_DEFINITIONS[playSlug] ?? ICP_DEFINITIONS["DEV-01"];

  // Check for Apollo integration
  const apolloIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "APOLLO" } },
  });

  // Load existing prospect emails to dedup
  const existingEmails = await prisma.outboundProspect.findMany({
    where: { workspaceId: run.agentConfig.workspaceId },
    select: { email: true },
  });
  const existingEmailSet = new Set(existingEmails.map((p) => p.email));
  const existingCount = existingEmailSet.size;

  let output: Record<string, unknown>;
  let costUsd = 0;

  if (apolloIntegration) {
    // ── Real Apollo API path ────────────────────────────────────────────────
    // Auth is an `x-api-key` header, not an `api_key` body field — Apollo
    // rejects the latter. See lib/integrations/catalog.ts (field key "apiKey")
    // and lib/integrations/verify/outbound.ts for the matching key verifier.
    const creds = await decryptCredentials<{ apiKey: string }>(
      apolloIntegration.encryptedCredentials
    );
    const apolloFilters = APOLLO_FILTERS[playSlug] ?? APOLLO_FILTERS["DEV-01"];

    // api_search (not the old, now-403ing `mixed_people/search`) is free but
    // deliberately never returns email addresses — Apollo only reveals those
    // through a per-person enrichment call that spends a credit. See the
    // reveal loop below.
    let searchRes: Response;
    try {
      searchRes = await apolloPeopleSearch(creds.apiKey, { ...apolloFilters, page: 1, per_page: maxProspects });
    } catch (err) {
      throw new AgentInputError(
        `Couldn't reach Apollo.io to source prospects for play ${playSlug}.`,
        "This is usually a transient network problem — try running Outbound Scout again. If it keeps happening, check Apollo's status page.",
        "apollo_unreachable",
      );
    }

    if (!searchRes.ok) {
      const isAuthFailure = searchRes.status === 401 || searchRes.status === 403;
      throw new AgentInputError(
        `Apollo.io rejected the prospect search for play ${playSlug} (HTTP ${searchRes.status}).`,
        isAuthFailure
          ? "The Apollo API key in Settings → Integrations → Apollo.io is invalid, revoked, or lacks the Master Key permission this search endpoint requires — reconnect it with a master key from Apollo's own API settings. This also 403s on Apollo plans below Professional."
          : "Check the Apollo.io account (rate limits, plan status) in Settings → Integrations, then try again.",
        "apollo_search_failed",
      );
    }

    const apolloData = (await searchRes.json()) as { people?: Array<Record<string, unknown>> };
    const people = apolloData.people ?? [];

    // Reveal an email for each match — the one Apollo call that costs credits,
    // same as clicking "unlock" on a contact in Apollo's own UI. Capped so a
    // large maxProspects can't drain the customer's whole credit balance in
    // one run; unrevealed matches are dropped rather than shipped with a
    // guessed or blank email; OutboundProspect.email is a required, unique
    // column, so a prospect without a real one can't be stored anyway.
    const toReveal = people.slice(0, Math.min(maxProspects, MAX_REVEALS_PER_RUN));
    const apolloProspects: Array<Record<string, unknown>> = [];
    let revealFailures = 0;

    for (const p of toReveal) {
      const personId = p.id as string | undefined;
      if (!personId) continue;

      try {
        const matchRes = await apolloMatchPerson(creds.apiKey, { id: personId });
        if (!matchRes.ok) {
          revealFailures++;
          continue;
        }
        const matchJson = (await matchRes.json()) as { person?: Record<string, unknown> };
        const person = matchJson.person;
        const email = (person?.email as string | undefined)?.toLowerCase();
        if (!person || !email) continue; // Apollo had no email to reveal for this match — skip, don't fabricate one.

        const org = (person.organization ?? {}) as Record<string, unknown>;
        const company = (org.name as string) ?? "";
        const title = (person.title as string) ?? "";
        apolloProspects.push({
          firstName: (person.first_name as string) ?? "",
          lastName: (person.last_name as string) ?? "",
          email,
          linkedInUrl: (person.linkedin_url as string) ?? "",
          title,
          company,
          companyDomain: (org.primary_domain as string) ?? (org.website_url as string) ?? "",
          employees: String(org.estimated_num_employees ?? ""),
          industry: (org.industry as string) ?? "",
          geography: (person.country as string) ?? "",
          primarySignal: `Sourced via Apollo.io — ${title} at ${company}`,
          additionalSignals: [],
          dataQualityScore: (person.email_status as string) === "verified" ? 5 : 3,
        });
      } catch {
        revealFailures++;
      }
    }

    // Every reveal call failing (as opposed to a few misses, which is normal —
    // not everyone has an unlockable email) points at something wrong with the
    // key or account rather than any individual person, so fail loudly instead
    // of quietly returning zero prospects from a run that looked successful.
    if (toReveal.length > 0 && apolloProspects.length === 0 && revealFailures === toReveal.length) {
      throw new AgentInputError(
        `Apollo.io found ${people.length} matching people for play ${playSlug} but every enrichment call to reveal an email failed.`,
        "Check the Apollo API key's remaining credits and permissions in Settings → Integrations → Apollo.io.",
        "apollo_reveal_failed",
      );
    }

    output = {
      prospects: apolloProspects,
      playSlug,
      sourcedAt: new Date().toISOString(),
      source: "apollo_live",
      totalMatched: people.length,
      revealed: apolloProspects.length,
      revealSkippedOrFailed: toReveal.length - apolloProspects.length,
    };
  } else {
    // ── Claude simulation fallback ──────────────────────────────────────────
    const { simOutput, costUsd: simCost } = await runClaudeSimulation(
      client,
      playSlug,
      icpDefinition,
      maxProspects,
      includeSignals
    );
    costUsd = simCost;
    output = simOutput;
    output.source = "simulation";
    output.simulationNote =
      "Simulated prospect sourcing — connect Apollo.io in Settings → Integrations to run live sourcing";
  }

  // Filter out any that match existing emails
  const prospects = Array.isArray(output.prospects) ? output.prospects : [];
  const newProspects = prospects.filter(
    (p: Record<string, unknown>) =>
      !existingEmailSet.has((p.email as string)?.toLowerCase() ?? "")
  );

  output.prospects = newProspects;
  output.totalSourced = prospects.length;
  output.dedupedOut = prospects.length - newProspects.length;
  output.existingInDB = existingCount;
  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
