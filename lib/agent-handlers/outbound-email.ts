import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { listInstantlyCampaigns } from "@/lib/integrations/instantly";
import type { OutboundEmailDelivery } from "./outbound-email-delivery";

// Re-exported for lib/agent-handlers/on-approve.ts and test/content.test.ts — the actual
// implementation lives in outbound-email-delivery.ts, which imports neither Prisma nor
// Anthropic, so it can be pulled into the test bundle on its own. See that file for why the
// stage/activate split exists.
export { activateOutboundEmailDelivery, buildOutboundEmailLeadBody, type OutboundEmailDelivery } from "./outbound-email-delivery";

const CAMPAIGN_MAP: Record<string, string> = {
  "DEV-01": "DEV-01-SAAS-V1",
  "DEV-02": "DEV-02-AGENCY-V1",
  "DEV-03": "DEV-03-PE-V1",
};

/** Per-run memo so a batch of leads for the same play only lists campaigns once. */
const campaignIdCache = new Map<string, { at: number; id: string }>();
const CAMPAIGN_CACHE_TTL_MS = 5 * 60_000;

/**
 * Instantly campaign ids are per-workspace UUIDs assigned when a campaign is
 * created in that account — nothing in this codebase can know one in advance.
 * Resolve the target by name instead: exact match on CAMPAIGN_MAP's value,
 * falling back to any campaign whose name contains the play slug (so renaming
 * "DEV-01-SAAS-V1" to something looser still works). No match is a
 * configuration problem the customer has to fix in Instantly, not something
 * to guess past.
 *
 * This is a read-only lookup — safe to run while staging, before approval.
 */
async function resolveInstantlyCampaignId(
  apiKey: string,
  targetName: string,
  playSlug: string,
): Promise<string> {
  const cacheKey = `${apiKey}:${playSlug}`;
  const cached = campaignIdCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CAMPAIGN_CACHE_TTL_MS) return cached.id;

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

  const match =
    campaigns.find((c) => c.name === targetName) ??
    campaigns.find((c) => c.name.toLowerCase().includes(playSlug.toLowerCase()));

  if (!match) {
    throw new AgentInputError(
      `No Instantly campaign named "${targetName}" (or matching play ${playSlug}) exists in this workspace's Instantly account.`,
      `Create a campaign in Instantly named "${targetName}", or rename an existing one to include "${playSlug}", then try again.`,
      "instantly_campaign_not_found",
    );
  }

  campaignIdCache.set(cacheKey, { at: Date.now(), id: match.id });
  return match.id;
}

export const outboundEmailHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  const prospectId = (input.prospectId ?? config.prospectId) as string | undefined;

  if (!prospectId) {
    const output = { error: "No prospectId in run.input.prospectId" };
    return { output, costUsd: 0 };
  }

  const prospect = await prisma.outboundProspect.findUnique({
    where: { id: prospectId },
    include: { play: true },
  });

  if (!prospect) {
    const output = { error: `Prospect ${prospectId} not found` };
    return { output, costUsd: 0 };
  }

  const instantlyIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "INSTANTLY" } },
  });

  if (prospect.channel === "WATCHLIST" || prospect.channel === "DISCARDED") {
    const output = {
      skipped: true,
      reason: `Prospect channel is ${prospect.channel} — not eligible for email outreach`,
      prospectId,
    };
    return { output, costUsd: 0 };
  }

  const intelligence = (prospect.intelligence ?? {}) as Record<string, unknown>;
  const intel = (intelligence.intelligence ?? {}) as Record<string, unknown>;
  const scoring = (intelligence.scoring ?? {}) as Record<string, unknown>;

  const systemPrompt = `You are an outbound email specialist for Dev.co. Your job is to generate personalised Instantly campaign variables for a specific prospect based on their Prospect Intelligence Object.

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

ICP Play: ${prospect.play.slug} — ${prospect.play.name}

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
  "campaignId": "${CAMPAIGN_MAP[prospect.play.slug] ?? "DEV-01-SAAS-V1"}",
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

  const variables = (variableOutput.variables ?? {}) as Record<string, string>;
  // CAMPAIGN_MAP is a target *name* to look up in the workspace's own Instantly
  // account below — never a live campaign id. Instantly ids are per-workspace
  // UUIDs; there is no way to know one in advance.
  const targetCampaignName = (CAMPAIGN_MAP[prospect.play.slug] ?? CAMPAIGN_MAP["DEV-01"]) as string;

  let campaignId = targetCampaignName;
  const connected = Boolean(instantlyIntegration);

  if (instantlyIntegration) {
    // Auth is a v2 Bearer key; a v1 key is rejected outright by v2 endpoints.
    // See lib/integrations/catalog.ts and lib/integrations/verify/outbound.ts.
    const credentials = await decryptCredentials<{ apiKey: string }>(instantlyIntegration.encryptedCredentials);
    // Read-only lookup — safe to run before approval.
    campaignId = await resolveInstantlyCampaignId(credentials.apiKey, targetCampaignName, prospect.play.slug);
  }

  const personalization: Record<string, string> = {
    pain_signal: variables.pain_signal ?? "",
    trigger: variables.trigger ?? "",
    offer_angle: variables.offer_angle ?? "",
    company_context: variables.company_context ?? "",
    proof_point: variables.proof_point ?? "",
  };

  const delivery: OutboundEmailDelivery = {
    status: "staged",
    prospectId,
    firstName: prospect.firstName,
    company: prospect.company,
    email: prospect.email,
    campaignName: targetCampaignName,
    campaignId,
    connected,
    personalization,
  };

  const output: Record<string, unknown> = {
    prospectId,
    firstName: prospect.firstName,
    company: prospect.company,
    email: prospect.email,
    campaignName: targetCampaignName,
    qualityNotes: variableOutput.qualityNotes,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
    delivery,
    approvalRequired: true,
    approvalNote: connected
      ? `Adding ${prospect.email} to the live Instantly campaign "${targetCampaignName}" requires workspace admin approval. Nothing has been sent to Instantly yet.`
      : `No Instantly integration is connected — approving this run will record a simulated lead add instead of a live one.`,
  };

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  await updateStatus("AWAITING_APPROVAL", output);
  return { output, costUsd };
};
