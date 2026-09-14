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
import { parsePlayConfig, buildApolloPeopleSearchFilters, selectPeopleToReveal, dedupeNewProspects, type OutboundPlayConfig } from "./outbound-play-config";

/** People that api_search matched, capped before we spend a credit revealing
 * each one's email. api_search itself has no per-record cost, but the reveal
 * step below does (one credit per person, same as unlocking a contact in
 * Apollo's own UI) — this bounds a large `maxProspects` from burning the
 * customer's whole balance in one run. */
const MAX_REVEALS_PER_RUN = 25;

async function runClaudeSimulation(
  client: Anthropic,
  playName: string,
  playConfig: OutboundPlayConfig,
  maxProspects: number,
  includeSignals: boolean
): Promise<{ simOutput: Record<string, unknown>; costUsd: number }> {
  const icpSummary = [
    playConfig.icp.titles.length ? `Titles: ${playConfig.icp.titles.join(", ")}` : null,
    playConfig.icp.seniorities.length ? `Seniorities: ${playConfig.icp.seniorities.join(", ")}` : null,
    playConfig.icp.employeeRanges.length ? `Employee ranges: ${playConfig.icp.employeeRanges.join(", ")}` : null,
    playConfig.icp.industries.length ? `Industries/keywords: ${playConfig.icp.industries.join(", ")}` : null,
    playConfig.icp.geographies.length ? `Geographies: ${playConfig.icp.geographies.join(", ")}` : null,
    playConfig.icp.technologies.length ? `Technologies: ${playConfig.icp.technologies.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const systemPrompt = `You are an outbound prospecting specialist. Your job is to generate a list of realistic, ICP-matched prospects for the outbound play "${playName}".

${playConfig.serviceOffer ? `What is being sold: ${playConfig.serviceOffer}` : ""}

Each prospect must be a real-seeming but fictional company and contact with plausible firmographics, verified contact data, and at least one observable buying signal.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Generate ${maxProspects} prospect records for the "${playName}" play.

ICP:
${icpSummary || "No ICP filters configured for this play yet — use reasonable business judgement."}

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
  "playName": "${playName}",
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
    simOutput = jsonMatch ? JSON.parse(jsonMatch[0]) : { prospects: [] };
  } catch {
    simOutput = { prospects: [], parseError: rawText.slice(0, 200) };
  }

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { simOutput, costUsd };
}

export const outboundScoutHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const workspaceId = run.agentConfig.workspaceId;
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  const playSlug = ((config.playSlug ?? input.playSlug) as string | undefined)?.trim();
  if (!playSlug) {
    return {
      output: { error: "No outbound play selected. Choose (or create) a play on the Outbound Engine page, then run Scout again." },
      costUsd: 0,
    };
  }

  const play = await prisma.outboundPlay.findUnique({
    where: { workspaceId_slug: { workspaceId, slug: playSlug } },
  });
  if (!play) {
    return {
      output: {
        error: `No outbound play "${playSlug}" exists for this workspace.`,
        hint: "Create it on the Outbound Engine page (/outbound), then run Scout again.",
      },
      costUsd: 0,
    };
  }
  if (!play.enabled) {
    return {
      output: { error: `The "${play.name}" play is disabled.`, hint: "Enable it on the Outbound Engine page to source against it." },
      costUsd: 0,
    };
  }

  const playConfig = parsePlayConfig(play.config);
  const requestedMax = typeof config.maxProspects === "number" ? config.maxProspects : playConfig.dailySourcingCap;
  const maxProspects = Math.max(1, Math.min(requestedMax, playConfig.dailySourcingCap));
  const includeSignals = config.includeSignals !== false;

  // Check for Apollo integration
  const apolloIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "APOLLO" } },
  });

  // Load existing prospect emails to dedup
  const existingEmails = await prisma.outboundProspect.findMany({
    where: { workspaceId },
    select: { email: true },
  });
  const existingEmailSet = new Set(existingEmails.map((p) => p.email));
  const existingCount = existingEmailSet.size;

  let output: Record<string, unknown>;
  let costUsd = 0;
  // Only the live Apollo path ever gets persisted to OutboundProspect below — simulated prospects
  // are clearly labelled (source: "simulation") and never written as real pipeline rows.
  const isLive = Boolean(apolloIntegration);

  if (apolloIntegration) {
    // ── Real Apollo API path ────────────────────────────────────────────────
    // Auth is an `x-api-key` header, not an `api_key` body field — Apollo
    // rejects the latter. See lib/integrations/catalog.ts (field key "apiKey")
    // and lib/integrations/verify/outbound.ts for the matching key verifier.
    const creds = await decryptCredentials<{ apiKey: string }>(
      apolloIntegration.encryptedCredentials
    );
    const apolloFilters = buildApolloPeopleSearchFilters(playConfig.icp);

    // api_search (not the old, now-403ing `mixed_people/search`) is free but
    // deliberately never returns email addresses — Apollo only reveals those
    // through a per-person enrichment call that spends a credit. See the
    // reveal loop below.
    let searchRes: Response;
    try {
      searchRes = await apolloPeopleSearch(creds.apiKey, { ...apolloFilters, page: 1, per_page: maxProspects });
    } catch {
      throw new AgentInputError(
        `Couldn't reach Apollo.io to source prospects for play "${play.name}".`,
        "This is usually a transient network problem — try running Outbound Scout again. If it keeps happening, check Apollo's status page.",
        "apollo_unreachable",
      );
    }

    if (!searchRes.ok) {
      const isAuthFailure = searchRes.status === 401 || searchRes.status === 403;
      throw new AgentInputError(
        `Apollo.io rejected the prospect search for play "${play.name}" (HTTP ${searchRes.status}).`,
        isAuthFailure
          ? "The Apollo API key in Settings → Integrations → Apollo.io is invalid, revoked, or lacks the Master Key permission this search endpoint requires — reconnect it with a master key from Apollo's own API settings. This also 403s on Apollo plans below Professional."
          : "Check the Apollo.io account (rate limits, plan status) in Settings → Integrations, then try again.",
        "apollo_search_failed",
      );
    }

    const apolloData = (await searchRes.json()) as { people?: Array<Record<string, unknown>> };
    const matched = apolloData.people ?? [];

    // Reveal an email for each match — the one Apollo call that costs credits,
    // same as clicking "unlock" on a contact in Apollo's own UI. Capped so a
    // large maxProspects can't drain the customer's whole credit balance in
    // one run; unrevealed matches are dropped rather than shipped with a
    // guessed or blank email; OutboundProspect.email is a required, unique
    // column, so a prospect without a real one can't be stored anyway.
    const { toReveal, excludedByRules: excludedCount } = selectPeopleToReveal(matched, {
      exclusions: playConfig.icp.exclusions,
      cap: Math.min(maxProspects, MAX_REVEALS_PER_RUN),
    });
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
        `Apollo.io found ${matched.length} matching people for play "${play.name}" but every enrichment call to reveal an email failed.`,
        "Check the Apollo API key's remaining credits and permissions in Settings → Integrations → Apollo.io.",
        "apollo_reveal_failed",
      );
    }

    output = {
      prospects: apolloProspects,
      sourcedAt: new Date().toISOString(),
      source: "apollo_live",
      totalMatched: matched.length,
      excludedByPlayRules: excludedCount,
      revealed: apolloProspects.length,
      revealSkippedOrFailed: toReveal.length - apolloProspects.length,
    };
  } else {
    // ── Claude simulation fallback ──────────────────────────────────────────
    const { client } = await resolveAnthropic(workspaceId);
    const { simOutput, costUsd: simCost } = await runClaudeSimulation(
      client,
      play.name,
      playConfig,
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
  const prospects = Array.isArray(output.prospects) ? (output.prospects as Array<Record<string, unknown>>) : [];
  const newProspects = dedupeNewProspects(prospects, existingEmailSet);

  // Persist — only for real, live-sourced prospects. Simulation never touches OutboundProspect;
  // it exists purely so the Strategist/Email agents have something to run against while Apollo
  // isn't connected. Upsert (not create) so a re-run that resources the same email — e.g. a retry
  // after a partial failure — can't collide with OutboundProspect's workspaceId+email uniqueness.
  let prospectIds: string[] = [];
  if (isLive && newProspects.length > 0) {
    const created = await Promise.all(
      newProspects.map((p) => {
        const email = String(p.email ?? "").toLowerCase();
        return prisma.outboundProspect.upsert({
          where: { workspaceId_email: { workspaceId, email } },
          create: {
            workspaceId,
            playId: play.id,
            firstName: String(p.firstName ?? ""),
            lastName: (p.lastName as string | undefined) || undefined,
            email,
            linkedInUrl: (p.linkedInUrl as string | undefined) || undefined,
            title: (p.title as string | undefined) || undefined,
            company: String(p.company ?? ""),
            companyDomain: (p.companyDomain as string | undefined) || undefined,
            status: "PENDING",
          },
          // Sourcing never overwrites a prospect that's already further along the pipeline.
          update: {},
        });
      }),
    );
    prospectIds = created.map((c) => c.id);
  }

  output.prospects = newProspects;
  output.prospectIds = prospectIds;
  output.totalSourced = prospects.length;
  output.dedupedOut = prospects.length - newProspects.length;
  output.existingInDB = existingCount;
  output.generatedAt = new Date().toISOString();
  output.workspaceId = workspaceId;
  output.playSlug = playSlug;
  output.playName = play.name;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
