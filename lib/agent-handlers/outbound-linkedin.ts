import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
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

// A target campaign *name* to look up in the workspace's own Aimfox account —
// Aimfox campaign ids are per-workspace and assigned when a campaign is
// created there, so nothing here can know one in advance. See
// resolveAimfoxCampaignId below.
const AIMFOX_CAMPAIGN_MAP: Record<string, string> = {
  "DEV-01": "DEV-01-LI-V1",
  "DEV-02": "DEV-02-LI-V1",
  "DEV-03": "DEV-03-LI-V1",
};

const AIMFOX_TIMEOUT_MS = 15_000;

/** Per-run memo so a batch of leads for the same play only lists campaigns once. */
const campaignIdCache = new Map<string, { at: number; id: string }>();
const CAMPAIGN_CACHE_TTL_MS = 5 * 60_000;

/**
 * Aimfox has a real REST API (api.aimfox.com/api/v2, Bearer key) — it is not
 * MCP-only. The MCP server at mcp.aimfox.com exists for chat clients like
 * Claude/ChatGPT; a server-to-server integration like this one uses the REST
 * API directly, which is simpler and doesn't require holding an MCP session
 * open for one call.
 *
 * This is a read-only lookup — safe to run while staging, before approval.
 */
async function resolveAimfoxCampaignId(
  apiKey: string,
  targetName: string,
  playSlug: string,
): Promise<string> {
  const cacheKey = `${apiKey}:${playSlug}`;
  const cached = campaignIdCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CAMPAIGN_CACHE_TTL_MS) return cached.id;

  let res: Response;
  try {
    res = await fetch("https://api.aimfox.com/api/v2/campaigns", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(AIMFOX_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AgentInputError(
      "Couldn't reach Aimfox to look up the outbound LinkedIn campaign.",
      "This is usually a transient network problem — try running Outbound LinkedIn again.",
      "aimfox_unreachable",
    );
  }
  if (!res.ok) {
    throw new AgentInputError(
      `Aimfox rejected the campaign lookup (HTTP ${res.status}).`,
      res.status === 401 || res.status === 403
        ? "The Aimfox API key in Settings → Integrations → Aimfox is invalid, revoked, or Read-only — reconnect it with an \"All\" permission key."
        : "Check the Aimfox account status in Settings → Integrations, then try again.",
      "aimfox_campaign_lookup_failed",
    );
  }

  const body = (await res.json()) as { items?: Array<{ id: string; name: string }>; data?: Array<{ id: string; name: string }> };
  const campaigns = body.items ?? body.data ?? [];
  const match =
    campaigns.find((c) => c.name === targetName) ??
    campaigns.find((c) => c.name.toLowerCase().includes(playSlug.toLowerCase()));

  if (!match) {
    throw new AgentInputError(
      `No Aimfox campaign named "${targetName}" (or matching play ${playSlug}) exists in this workspace's Aimfox account.`,
      `Create a campaign in Aimfox named "${targetName}", or rename an existing one to include "${playSlug}", then try again.`,
      "aimfox_campaign_not_found",
    );
  }

  campaignIdCache.set(cacheKey, { at: Date.now(), id: match.id });
  return match.id;
}

export const outboundLinkedinHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  const prospectId = (input.prospectId ?? config.prospectId) as string | undefined;

  if (!prospectId) {
    return { output: { error: "No prospectId in run.input.prospectId" }, costUsd: 0 };
  }

  const prospect = await prisma.outboundProspect.findUnique({
    where: { id: prospectId },
    include: { play: true },
  });

  if (!prospect) {
    return { output: { error: `Prospect ${prospectId} not found` }, costUsd: 0 };
  }

  if (prospect.channel !== "EMAIL_AND_LINKEDIN") {
    return {
      output: {
        skipped: true,
        reason: `Channel is ${prospect.channel} — LinkedIn reserved for 80+ score prospects`,
        prospectId,
        score: prospect.score,
      },
      costUsd: 0,
    };
  }

  if (!prospect.linkedInUrl) {
    return { output: { skipped: true, reason: "No LinkedIn URL on prospect record", prospectId }, costUsd: 0 };
  }

  const aimfoxIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "AIMFOX" } },
  });

  const intelligence = (prospect.intelligence ?? {}) as Record<string, unknown>;
  const intel = (intelligence.intelligence ?? {}) as Record<string, unknown>;

  const systemPrompt = `You are an outbound LinkedIn specialist for Dev.co. You write human, curious, non-salesy connection notes and follow-up messages for senior technical and business leaders.

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

Play: ${prospect.play.slug} — ${prospect.play.name}

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

  const targetCampaignName = AIMFOX_CAMPAIGN_MAP[prospect.play.slug] ?? AIMFOX_CAMPAIGN_MAP["DEV-01"];
  let campaignId: string = targetCampaignName;
  const connected = Boolean(aimfoxIntegration);

  if (aimfoxIntegration) {
    // Auth is a Bearer API key, not an MCP OAuth access token. See
    // lib/integrations/catalog.ts and lib/integrations/verify/outbound.ts.
    const creds = await decryptCredentials<{ apiKey: string }>(aimfoxIntegration.encryptedCredentials);
    // Read-only lookup — safe to run before approval.
    campaignId = await resolveAimfoxCampaignId(creds.apiKey, targetCampaignName, prospect.play.slug);
  }

  const connectionNote = String(msgOutput.connectionNote ?? "");
  const message1 = String(msgOutput.message1 ?? "");
  const message2 = String(msgOutput.message2 ?? "");

  const delivery: OutboundLinkedinDelivery = {
    status: "staged",
    prospectId,
    firstName: prospect.firstName,
    company: prospect.company,
    linkedInUrl: prospect.linkedInUrl,
    campaignName: targetCampaignName,
    campaignId,
    connected,
    connectionNote,
    message1,
    message2,
  };

  const output: Record<string, unknown> = {
    prospectId,
    firstName: prospect.firstName,
    company: prospect.company,
    linkedInUrl: prospect.linkedInUrl,
    campaignName: targetCampaignName,
    connectionNote,
    message1,
    message2,
    characterCounts: msgOutput.characterCounts,
    toneNotes: msgOutput.toneNotes,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
    delivery,
    approvalRequired: true,
    approvalNote: connected
      ? `Adding ${prospect.firstName} (${prospect.linkedInUrl}) to the live Aimfox campaign "${targetCampaignName}" requires workspace admin approval. Nothing has been sent to Aimfox yet.`
      : `No Aimfox integration is connected — approving this run will record a simulated add instead of a live one.`,
  };

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  await updateStatus("AWAITING_APPROVAL", output);
  return { output, costUsd };
};
