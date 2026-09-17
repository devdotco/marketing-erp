import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import type { OutboundPlay, OutboundProspect } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { listInstantlyCampaigns } from "@/lib/integrations/instantly";
import { apolloEnrichOrganization, apolloMatchPerson } from "@/lib/integrations/apollo";
import {
  isApolloDataStale,
  mapApolloOrg,
  mapApolloPerson,
  type StoredApolloEnrichment,
} from "./outbound-strategist";
import { parsePlayConfig, planCampaignResolution, type OutboundPlayConfig } from "./outbound-play-config";
import type { OutboundEmailDelivery } from "./outbound-email-delivery";

// Re-exported for lib/agent-handlers/on-approve.ts and test/content.test.ts — the actual
// implementation lives in outbound-email-delivery.ts, which imports neither Prisma nor
// Anthropic, so it can be pulled into the test bundle on its own. See that file for why the
// stage/activate split exists.
export { activateOutboundEmailDelivery, buildOutboundEmailLeadBody, type OutboundEmailDelivery } from "./outbound-email-delivery";

/** Total Apollo enrichment calls (org + person) this run will make across every prospect in the
 * batch that's missing intelligence and has no fresh cached data — mirrors
 * outbound-strategist.ts's default maxApolloLookups so a large batch can't drain the account's
 * credit balance just from Email Outbound backfilling what Strategist would normally have done. */
const ENRICHMENT_BUDGET = 25;
const ENRICHMENT_FRESHNESS_DAYS = 30;

/** Memo so a batch of leads across several plays only lists Instantly's campaigns once — keyed by
 * API key (not just "the last call"), since this module is shared across every workspace's runs
 * in the same worker process and a bare single-slot cache would leak one tenant's campaign list
 * into another's lookup. */
const campaignListCache = new Map<string, { at: number; campaigns: Array<{ id: string; name: string }> }>();
const CAMPAIGN_CACHE_TTL_MS = 5 * 60_000;

async function listCampaignsCached(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const cached = campaignListCache.get(apiKey);
  if (cached && Date.now() - cached.at < CAMPAIGN_CACHE_TTL_MS) return cached.campaigns;
  let campaigns: Array<{ id: string; name: string }>;
  try {
    campaigns = await listInstantlyCampaigns(apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("unreachable:")) {
      throw new AgentInputError(
        "Couldn't reach Instantly to look up the outbound campaign.",
        "This is usually a transient network problem — try running Outbound Email again.",
        "instantly_unreachable",
      );
    }
    const status = Number(message.match(/^http_(\d+)/)?.[1] ?? 0);
    throw new AgentInputError(
      `Instantly rejected the campaign lookup (HTTP ${status || "unknown"}).`,
      status === 401 || status === 403
        ? "The Instantly API key in Settings → Integrations → Instantly is invalid, revoked, or not a v2 key — reconnect it there."
        : "Check the Instantly account status in Settings → Integrations, then try again.",
      "instantly_campaign_lookup_failed",
    );
  }
  campaignListCache.set(apiKey, { at: Date.now(), campaigns });
  return campaigns;
}

/**
 * Resolves a play's configured Instantly campaign to a live id. A campaign chosen through the
 * play editor's dropdown (components/ui/ResourceSelect via /api/outbound/integrations/options)
 * already IS a live id — playConfig.instantlyCampaignId — so the common case needs no lookup at
 * all. Only a play whose campaign was typed as plain text while Instantly wasn't connected yet
 * (playConfig.instantlyCampaignName only) falls back to a by-name search, same convention as
 * every other by-name lookup in this codebase (Aimfox, GHL pipelines).
 *
 * `apiKey` is always a real, connected key here — outboundEmailHandler refuses the whole run
 * before this is ever called if Instantly isn't connected (see its own doc comment), so there is
 * no "not connected, resolve nothing yet" branch to fall back to.
 */
async function resolveInstantlyCampaign(
  apiKey: string,
  playConfig: OutboundPlayConfig,
  playName: string,
): Promise<{ campaignId: string; campaignName: string }> {
  const plan = planCampaignResolution(playConfig.instantlyCampaignId, playConfig.instantlyCampaignName);
  if (plan.mode === "id") {
    return { campaignId: plan.campaignId, campaignName: plan.campaignName };
  }
  if (plan.mode === "unconfigured") {
    throw new AgentInputError(
      `The "${playName}" play has no Instantly campaign configured.`,
      "Set one on the Outbound Engine page (/outbound) — pick it from the dropdown once Instantly is connected, or type its name if it isn't yet.",
      "outbound_play_no_campaign",
    );
  }

  const targetName = plan.targetName;
  const campaigns = await listCampaignsCached(apiKey);
  const match = campaigns.find((c) => c.name === targetName) ?? campaigns.find((c) => c.name.toLowerCase().includes(targetName.toLowerCase()));
  if (!match) {
    throw new AgentInputError(
      `No Instantly campaign named "${targetName}" exists in this workspace's Instantly account.`,
      `Create a campaign in Instantly named "${targetName}", or pick the right one from the dropdown on the Outbound Engine page.`,
      "instantly_campaign_not_found",
    );
  }
  return { campaignId: match.id, campaignName: targetName };
}

/** Backfills Apollo org/person enrichment for one prospect when it's missing or stale — the same
 * mapApolloOrg/mapApolloPerson shapes and isApolloDataStale freshness check outbound-strategist.ts
 * uses, exported from there rather than duplicated here (see that file). Only called when a
 * prospect reaches this agent without having gone through the Strategist first (a manual run, or
 * an explicit prospectIds run) and has no usable Intelligence Object yet. Budget-limited and
 * best-effort: an enrichment failure here never fails the run, it just leaves the prospect's
 * personalisation a little more generic. */
async function backfillApolloEnrichment(
  apiKey: string,
  prospect: OutboundProspect,
  budget: { remaining: number },
): Promise<StoredApolloEnrichment | null> {
  const stored = (prospect.apolloEnrichment ?? null) as StoredApolloEnrichment | null;
  const domain = prospect.companyDomain?.trim().toLowerCase();
  const now = new Date().toISOString();
  const result: StoredApolloEnrichment = { ...stored };
  let changed = false;

  if (domain && budget.remaining > 0 && isApolloDataStale(stored?.org?.fetchedAt, ENRICHMENT_FRESHNESS_DAYS)) {
    budget.remaining -= 1;
    try {
      const res = await apolloEnrichOrganization(apiKey, domain);
      if (res.ok) {
        const json = (await res.json()) as { organization?: Parameters<typeof mapApolloOrg>[0] };
        const org = mapApolloOrg(json.organization, domain, now);
        if (org) {
          result.org = org;
          changed = true;
        }
      }
    } catch {
      // Best-effort — see doc comment.
    }
  }

  if (budget.remaining > 0 && isApolloDataStale(stored?.person?.fetchedAt, ENRICHMENT_FRESHNESS_DAYS)) {
    budget.remaining -= 1;
    try {
      const res = await apolloMatchPerson(apiKey, { email: prospect.email });
      if (res.ok) {
        const json = (await res.json()) as { person?: Parameters<typeof mapApolloPerson>[0] };
        const person = mapApolloPerson(json.person, now);
        if (person) {
          result.person = person;
          changed = true;
        }
      }
    } catch {
      // Best-effort — see doc comment.
    }
  }

  return changed ? result : stored;
}

async function generateVariables(
  client: Anthropic,
  prospect: OutboundProspect,
  play: OutboundPlay,
): Promise<{ variables: Record<string, string>; qualityNotes: unknown; costUsd: number }> {
  const intelligence = (prospect.intelligence ?? {}) as Record<string, unknown>;
  const intel = (intelligence.intelligence ?? {}) as Record<string, unknown>;
  const scoring = (intelligence.scoring ?? {}) as Record<string, unknown>;

  const systemPrompt = `You are an outbound email specialist. Your job is to generate personalised Instantly campaign variables for a specific prospect based on their Prospect Intelligence Object.

The variables will be injected into an email template. Each variable must be concise, specific to this prospect, and avoid generic outsourcing language.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Generate Instantly email variables for this prospect.

Prospect:
- Name: ${prospect.firstName} ${prospect.lastName ?? ""}
- Title: ${prospect.title ?? "Unknown"}
- Company: ${prospect.company}
- Email: ${prospect.email}

Intelligence Object:
- Pain hypothesis: ${(intel.painHypothesis as string) ?? "Not available"}
- Primary signal: ${(intel.primarySignal as string) ?? "Not available"}
- Messaging angle: ${(intel.messagingAngle as string) ?? "Not available"}
- Best offer: ${(intel.bestOffer as string) ?? "Not available"}
- Avoid: ${(intel.avoid as string) ?? "Nothing specific"}
- Context: ${(intel.companyContext as string) ?? "Not available"}
- Score: ${scoring.total ?? 0}/100

Play: ${play.slug} — ${play.name}

Return exactly this JSON structure:
{
  "variables": {
    "first_name": "string",
    "pain_signal": "string (1 specific observable signal, <12 words)",
    "trigger": "string (why reach out NOW — timing-specific, <10 words)",
    "offer_angle": "string (the specific angle for this person, NOT generic outsourcing, <15 words)",
    "company_context": "string (1 compact fact about their situation, <12 words)",
    "proof_point": "string (social proof relevant to their situation, <15 words)"
  },
  "qualityNotes": "string (any variables where you had to guess — flag them)"
}`;

  const message = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let variableOutput: Record<string, unknown>;
  try {
    variableOutput = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    variableOutput = {};
  }

  return {
    variables: (variableOutput.variables ?? {}) as Record<string, string>,
    qualityNotes: variableOutput.qualityNotes,
    costUsd: estimateCostUsd(MODELS.fast, message.usage),
  };
}

export const outboundEmailHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  // "prospectIds" (batch, from Strategist via chaining.ts, or a manual multi-prospect run) and
  // "prospectId" (single — the pre-batch shape, still the common manual-trigger case) both work;
  // "prospectId" is read via `config` because it's a declared saved-config-backed form field, while
  // "prospectIds" is always a one-off run input, never a saved default.
  const prospectIds = Array.isArray(input.prospectIds)
    ? (input.prospectIds as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const singleId = (input.prospectId ?? config.prospectId) as string | undefined;
  const allIds = [...new Set([...prospectIds, ...(singleId ? [singleId] : [])])];

  if (allIds.length === 0) {
    return { output: { error: "No prospectId(s) in run.input.prospectId / run.input.prospectIds" }, costUsd: 0 };
  }

  // Instantly is this agent's only send channel — checked before the prospect lookup below (a DB
  // query that would otherwise run for nothing) and, more importantly, before generateVariables()
  // starts spending Anthropic tokens writing personalisation for prospects that would just sit
  // staged forever with nowhere real to send. This used to stage anyway and let approval silently
  // fabricate `instantly_...` lead ids instead (see outbound-email-delivery.ts) — refusing here,
  // up front, is the legible version: names the integration, says where to connect it, and spends
  // nothing on a run that can't complete for real.
  const instantlyIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "INSTANTLY" } },
  });
  if (!instantlyIntegration) {
    throw new AgentInputError(
      "Instantly isn't connected for this workspace, so Outbound Email has no live campaign to add these leads to.",
      "Connect Instantly in Settings → Integrations → Instantly, then run Outbound Email again.",
      "instantly_not_connected",
    );
  }
  const connected = true;
  const apiKey = (await decryptCredentials<{ apiKey: string }>(instantlyIntegration.encryptedCredentials)).apiKey;

  const prospects = await prisma.outboundProspect.findMany({
    where: { id: { in: allIds }, workspaceId: run.agentConfig.workspaceId },
    include: { play: true },
  });

  const playConfigCache = new Map<string, OutboundPlayConfig>();
  const campaignCache = new Map<string, { campaignId: string; campaignName: string }>();
  const enrichmentBudget = { remaining: ENRICHMENT_BUDGET };

  const deliveries: OutboundEmailDelivery[] = [];
  const skipped: Array<{ prospectId: string; reason: string }> = [];
  let costUsd = 0;

  for (const prospectId of allIds) {
    const prospect = prospects.find((p) => p.id === prospectId);
    if (!prospect) {
      skipped.push({ prospectId, reason: "Prospect not found in this workspace" });
      continue;
    }
    if (prospect.channel === "WATCHLIST" || prospect.channel === "DISCARDED") {
      skipped.push({ prospectId, reason: `Prospect channel is ${prospect.channel} — not eligible for email outreach` });
      continue;
    }

    if (!playConfigCache.has(prospect.playId)) playConfigCache.set(prospect.playId, parsePlayConfig(prospect.play.config));
    const playConfig = playConfigCache.get(prospect.playId)!;

    let campaign: { campaignId: string; campaignName: string };
    try {
      if (!campaignCache.has(prospect.playId)) {
        campaignCache.set(prospect.playId, await resolveInstantlyCampaign(apiKey, playConfig, prospect.play.name));
      }
      campaign = campaignCache.get(prospect.playId)!;
    } catch (err) {
      if (err instanceof AgentInputError && allIds.length > 1) {
        // A batch with a campaign-configuration problem for one play shouldn't block prospects on
        // a different, correctly-configured play in the same run.
        skipped.push({ prospectId, reason: err.message });
        continue;
      }
      throw err;
    }

    // Reuses the Strategist's Intelligence Object when there is one; backfills a minimal Apollo
    // enrichment when there isn't (a prospect that reached this agent without Strategist having
    // run — a manual/explicit-id trigger) so personalisation still has real facts to work from
    // instead of only the bare prospect record.
    let workingProspect = prospect;
    const hasIntelligence = !!(prospect.intelligence && Object.keys(prospect.intelligence as object).length > 0);
    if (!hasIntelligence && apiKey && enrichmentBudget.remaining > 0) {
      const enrichment = await backfillApolloEnrichment(apiKey, prospect, enrichmentBudget);
      if (enrichment) {
        // Merged locally rather than reassigned from the update() result — that result has no
        // `play` relation loaded (this is a plain update, not the findMany-with-include above), and
        // generateVariables below needs workingProspect.play.
        workingProspect = { ...prospect, apolloEnrichment: JSON.parse(JSON.stringify(enrichment)) };
        await prisma.outboundProspect
          .updateMany({ where: { id: prospect.id, workspaceId: run.agentConfig.workspaceId }, data: { apolloEnrichment: workingProspect.apolloEnrichment as object } })
          .catch((err) => console.error(`[outbound-email] could not persist backfilled enrichment for ${prospect.id}:`, err));
      }
    }

    const { variables, qualityNotes, costUsd: genCost } = await generateVariables(client, workingProspect, prospect.play);
    costUsd += genCost;

    const personalization: Record<string, string> = {
      pain_signal: variables.pain_signal ?? "",
      trigger: variables.trigger ?? "",
      offer_angle: variables.offer_angle ?? "",
      company_context: variables.company_context ?? "",
      proof_point: variables.proof_point ?? "",
    };

    deliveries.push({
      status: "staged",
      prospectId: prospect.id,
      firstName: prospect.firstName,
      company: prospect.company,
      email: prospect.email,
      campaignName: campaign.campaignName,
      campaignId: campaign.campaignId,
      connected,
      personalization,
    });

    if (qualityNotes) skipped.push({ prospectId, reason: `note: ${String(qualityNotes)}` });
  }

  const output: Record<string, unknown> = {
    deliveries,
    // Back-compat with the pre-batch single-prospect shape: when exactly one delivery was staged,
    // also surface it at the top level as `delivery` — on-approve.ts, the run page, and any
    // existing AWAITING_APPROVAL run created before batching still read this shape.
    ...(deliveries.length === 1 ? { delivery: deliveries[0] } : {}),
    staged: deliveries.length,
    skipped,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
    approvalRequired: true,
    // Instantly being connected is no longer conditional here — the handler refuses the whole run
    // above if it isn't (see that check's doc comment) — so this note only ever describes the real,
    // live-send path.
    approvalNote: `Adding ${deliveries.length} prospect${deliveries.length === 1 ? "" : "s"} to their live Instantly campaign${deliveries.length === 1 ? "" : "s"} requires workspace admin approval. Nothing has been sent to Instantly yet.`,
  };

  await updateStatus("AWAITING_APPROVAL", output);
  return { output, costUsd };
};
