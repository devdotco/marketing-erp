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
import { listAimfoxCampaigns } from "@/lib/integrations/aimfox";
import { parsePlayConfig, planCampaignResolution, type OutboundPlayConfig } from "./outbound-play-config";
import type { OutboundLinkedinDelivery } from "./outbound-linkedin-delivery";

// Re-exported for lib/agent-handlers/on-approve.ts and test/content.test.ts — the actual
// implementation lives in outbound-linkedin-delivery.ts, which imports neither Prisma nor
// Anthropic, so it can be pulled into the test bundle on its own. See that file for why the
// stage/activate split exists.
export {
  activateOutboundLinkedinDelivery,
  buildAimfoxAudienceBody,
  type OutboundLinkedinDelivery,
} from "./outbound-linkedin-delivery";

/** Memo so a batch across several plays only lists Aimfox's campaigns once — keyed by API key,
 * not a bare single slot, since this module is shared across every workspace's runs in the same
 * worker process (see outbound-email.ts's identical cache for the same reason). */
const campaignListCache = new Map<string, { at: number; campaigns: Array<{ id: string; name: string }> }>();
const CAMPAIGN_CACHE_TTL_MS = 5 * 60_000;

async function listCampaignsCached(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const cached = campaignListCache.get(apiKey);
  if (cached && Date.now() - cached.at < CAMPAIGN_CACHE_TTL_MS) return cached.campaigns;
  let campaigns: Array<{ id: string; name: string }>;
  try {
    campaigns = await listAimfoxCampaigns(apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("unreachable:")) {
      throw new AgentInputError(
        "Couldn't reach Aimfox to look up the outbound LinkedIn campaign.",
        "This is usually a transient network problem — try running Outbound LinkedIn again.",
        "aimfox_unreachable",
      );
    }
    const status = Number(message.match(/^http_(\d+)/)?.[1] ?? 0);
    throw new AgentInputError(
      `Aimfox rejected the campaign lookup (HTTP ${status || "unknown"}).`,
      status === 401 || status === 403
        ? "The Aimfox API key in Settings → Integrations → Aimfox is invalid, revoked, or Read-only — reconnect it with an \"All\" permission key."
        : "Check the Aimfox account status in Settings → Integrations, then try again.",
      "aimfox_campaign_lookup_failed",
    );
  }
  campaignListCache.set(apiKey, { at: Date.now(), campaigns });
  return campaigns;
}

/** Same convention as outbound-email.ts's resolveInstantlyCampaign: a campaign chosen through the
 * play editor's dropdown already carries a live id (playConfig.aimfoxCampaignId), so the common
 * case needs no lookup. Only a campaign typed as plain text while Aimfox wasn't connected yet
 * falls back to a by-name search. */
async function resolveAimfoxCampaign(
  apiKey: string | null,
  playConfig: OutboundPlayConfig,
  playName: string,
): Promise<{ campaignId: string; campaignName: string }> {
  const plan = planCampaignResolution(playConfig.aimfoxCampaignId, playConfig.aimfoxCampaignName);
  if (plan.mode === "id") {
    return { campaignId: plan.campaignId, campaignName: plan.campaignName };
  }
  if (plan.mode === "unconfigured") {
    throw new AgentInputError(
      `The "${playName}" play has no Aimfox campaign configured.`,
      "Set one on the Outbound Engine page (/outbound) — pick it from the dropdown once Aimfox is connected, or type its name if it isn't yet.",
      "outbound_play_no_campaign",
    );
  }

  const targetName = plan.targetName;
  if (!apiKey) {
    return { campaignId: targetName, campaignName: targetName };
  }

  const campaigns = await listCampaignsCached(apiKey);
  const match = campaigns.find((c) => c.name === targetName) ?? campaigns.find((c) => c.name.toLowerCase().includes(targetName.toLowerCase()));
  if (!match) {
    throw new AgentInputError(
      `No Aimfox campaign named "${targetName}" exists in this workspace's Aimfox account.`,
      `Create a campaign in Aimfox named "${targetName}", or pick the right one from the dropdown on the Outbound Engine page.`,
      "aimfox_campaign_not_found",
    );
  }
  return { campaignId: match.id, campaignName: targetName };
}

async function generateMessages(
  client: Anthropic,
  prospect: OutboundProspect,
  play: OutboundPlay,
): Promise<{ connectionNote: string; message1: string; message2: string; characterCounts: unknown; toneNotes: unknown; costUsd: number }> {
  const intelligence = (prospect.intelligence ?? {}) as Record<string, unknown>;
  const intel = (intelligence.intelligence ?? {}) as Record<string, unknown>;

  const systemPrompt = `You write human, curious, non-salesy connection notes and follow-up messages for senior technical and business leaders.

Rules:
- Connection note: max 300 characters. Reference something observable about them. No pitch. No "I'd love to" language.
- Message 1 (sent after connection accepted, 2 days later): max 500 characters. Reference the signal. Start a conversation. End with a genuine question.
- Never say "outsourcing", "offshore", or "staffing". Frame as capacity and partnership.
- Sound like a peer, not a vendor.

Always respond with valid JSON only.`;

  const userPrompt = `Write the Aimfox LinkedIn sequence messages for this prospect.

Prospect:
- Name: ${prospect.firstName} ${prospect.lastName ?? ""}
- Title: ${prospect.title ?? "Unknown"}
- Company: ${prospect.company}
- LinkedIn: ${prospect.linkedInUrl}

Intelligence:
- Primary signal: ${(intel.primarySignal as string) ?? "Not available"}
- Pain hypothesis: ${(intel.painHypothesis as string) ?? "Not available"}
- Messaging angle: ${(intel.messagingAngle as string) ?? "Not available"}
- Avoid: ${(intel.avoid as string) ?? "Nothing specific"}
- Context: ${(intel.companyContext as string) ?? "Not available"}

Play: ${play.slug} — ${play.name}

Return exactly:
{
  "connectionNote": "string (≤300 chars, no pitch, references something real)",
  "message1": "string (≤500 chars, opens conversation after connection)",
  "message2": "string (≤500 chars, qualifying question if no reply after 5 days)",
  "characterCounts": { "connectionNote": 0, "message1": 0, "message2": 0 },
  "toneNotes": "string"
}`;

  const message = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let msgOutput: Record<string, unknown>;
  try {
    msgOutput = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    msgOutput = {};
  }

  return {
    connectionNote: String(msgOutput.connectionNote ?? ""),
    message1: String(msgOutput.message1 ?? ""),
    message2: String(msgOutput.message2 ?? ""),
    characterCounts: msgOutput.characterCounts,
    toneNotes: msgOutput.toneNotes,
    costUsd: estimateCostUsd(MODELS.fast, message.usage),
  };
}

export const outboundLinkedinHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  // Same "prospectIds" (batch) / "prospectId" (single, declared config field) split as
  // outbound-email.ts — see that file's comment.
  const prospectIds = Array.isArray(input.prospectIds)
    ? (input.prospectIds as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const singleId = (input.prospectId ?? config.prospectId) as string | undefined;
  const allIds = [...new Set([...prospectIds, ...(singleId ? [singleId] : [])])];

  if (allIds.length === 0) {
    return { output: { error: "No prospectId(s) in run.input.prospectId / run.input.prospectIds" }, costUsd: 0 };
  }

  const prospects = await prisma.outboundProspect.findMany({
    where: { id: { in: allIds }, workspaceId: run.agentConfig.workspaceId },
    include: { play: true },
  });

  const aimfoxIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "AIMFOX" } },
  });
  const connected = Boolean(aimfoxIntegration);
  const apiKey = aimfoxIntegration
    ? (await decryptCredentials<{ apiKey: string }>(aimfoxIntegration.encryptedCredentials)).apiKey
    : null;

  const playConfigCache = new Map<string, OutboundPlayConfig>();
  const campaignCache = new Map<string, { campaignId: string; campaignName: string }>();

  const deliveries: OutboundLinkedinDelivery[] = [];
  const skipped: Array<{ prospectId: string; reason: string }> = [];
  let costUsd = 0;

  for (const prospectId of allIds) {
    const prospect = prospects.find((p) => p.id === prospectId);
    if (!prospect) {
      skipped.push({ prospectId, reason: "Prospect not found in this workspace" });
      continue;
    }
    if (prospect.channel !== "EMAIL_AND_LINKEDIN") {
      skipped.push({ prospectId, reason: `Channel is ${prospect.channel} — LinkedIn reserved for the play's top routing tier` });
      continue;
    }
    if (!prospect.linkedInUrl) {
      skipped.push({ prospectId, reason: "No LinkedIn URL on prospect record" });
      continue;
    }

    if (!playConfigCache.has(prospect.playId)) playConfigCache.set(prospect.playId, parsePlayConfig(prospect.play.config));
    const playConfig = playConfigCache.get(prospect.playId)!;

    let campaign: { campaignId: string; campaignName: string };
    try {
      if (!campaignCache.has(prospect.playId)) {
        campaignCache.set(prospect.playId, await resolveAimfoxCampaign(apiKey, playConfig, prospect.play.name));
      }
      campaign = campaignCache.get(prospect.playId)!;
    } catch (err) {
      if (err instanceof AgentInputError && allIds.length > 1) {
        skipped.push({ prospectId, reason: err.message });
        continue;
      }
      throw err;
    }

    const { connectionNote, message1, message2, costUsd: genCost } = await generateMessages(client, prospect, prospect.play);
    costUsd += genCost;

    deliveries.push({
      status: "staged",
      prospectId: prospect.id,
      firstName: prospect.firstName,
      company: prospect.company,
      linkedInUrl: prospect.linkedInUrl,
      campaignName: campaign.campaignName,
      campaignId: campaign.campaignId,
      connected,
      connectionNote,
      message1,
      message2,
    });
  }

  const output: Record<string, unknown> = {
    deliveries,
    // Back-compat with the pre-batch single-prospect shape — see outbound-email.ts's identical note.
    ...(deliveries.length === 1 ? { delivery: deliveries[0] } : {}),
    staged: deliveries.length,
    skipped,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
    approvalRequired: true,
    approvalNote: connected
      ? `Adding ${deliveries.length} prospect${deliveries.length === 1 ? "" : "s"} to their live Aimfox campaign${deliveries.length === 1 ? "" : "s"} requires workspace admin approval. Nothing has been sent to Aimfox yet.`
      : `No Aimfox integration is connected — approving this run will record simulated adds instead of live ones.`,
  };

  await updateStatus("AWAITING_APPROVAL", output);
  return { output, costUsd };
};
