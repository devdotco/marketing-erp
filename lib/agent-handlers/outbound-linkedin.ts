import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

const AIMFOX_CAMPAIGN_MAP: Record<string, string> = {
  "DEV-01": "DEV-01-LI-V1",
  "DEV-02": "DEV-02-LI-V1",
  "DEV-03": "DEV-03-LI-V1",
};

export const outboundLinkedinHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
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

  if (prospect.channel !== "EMAIL_AND_LINKEDIN") {
    const output = {
      skipped: true,
      reason: `Prospect channel is ${prospect.channel} — LinkedIn reserved for score 80+ (EMAIL_AND_LINKEDIN)`,
      prospectId,
      score: prospect.score,
    };
    return { output, costUsd: 0 };
  }

  if (!prospect.linkedInUrl) {
    const output = {
      skipped: true,
      reason: "No LinkedIn URL on prospect record",
      prospectId,
    };
    return { output, costUsd: 0 };
  }

  const aimfoxIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "AIMFOX" } },
  });

  const intelligence = (prospect.intelligence ?? {}) as Record<string, unknown>;
  const intel = (intelligence.intelligence ?? {}) as Record<string, unknown>;

  const systemPrompt = `You are an outbound LinkedIn specialist for Dev.co. You write human, curious, non-salesy connection notes and follow-up messages for senior technical and business leaders.

Rules:
- Connection note: max 300 characters. Reference something observable about them. No pitch. No "I'd love to" language.
- Message 1 (sent after connection is accepted, 2 days later): max 500 characters. Reference the signal. Start a conversation — don't pitch. End with a genuine question.
- Never mention "outsourcing", "offshore", or "staffing". Frame as capacity and partnership.
- Sound like a peer, not a vendor.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Write the Aimfox LinkedIn sequence messages for this prospect.

Prospect:
- Name: ${prospect.firstName} ${prospect.lastName ?? ""}
- Title: ${prospect.title ?? "Unknown"}
- Company: ${prospect.company}
- LinkedIn: ${prospect.linkedInUrl}

Intelligence Object:
- Primary signal: ${(intel.primarySignal as string) ?? "Not available"}
- Pain hypothesis: ${(intel.painHypothesis as string) ?? "Not available"}
- Messaging angle: ${(intel.messagingAngle as string) ?? "Not available"}
- Avoid: ${(intel.avoid as string) ?? "Nothing specific"}
- Context: ${(intel.companyContext as string) ?? "Not available"}

ICP Play: ${prospect.play.slug} — ${prospect.play.name}

Return exactly this JSON structure:
{
  "connectionNote": "string (≤300 chars, no pitch, references something real)",
  "message1": "string (≤500 chars, sent 2 days after connection, opens conversation)",
  "message2": "string (≤500 chars, sent 5 days after message1 if no reply — qualifying question only)",
  "characterCounts": {
    "connectionNote": 0,
    "message1": 0,
    "message2": 0
  },
  "toneNotes": "string (brief note on tone choices made)"
}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let msgOutput: Record<string, unknown>;
  try {
    msgOutput = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    msgOutput = {};
  }

  const campaignId = AIMFOX_CAMPAIGN_MAP[prospect.play.slug] ?? "DEV-01-LI-V1";

  const output: Record<string, unknown> = {
    prospectId,
    firstName: prospect.firstName,
    company: prospect.company,
    linkedInUrl: prospect.linkedInUrl,
    campaignId,
    connectionNote: msgOutput.connectionNote,
    message1: msgOutput.message1,
    message2: msgOutput.message2,
    characterCounts: msgOutput.characterCounts,
    toneNotes: msgOutput.toneNotes,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
  };

  let aimfoxLeadId: string;

  if (aimfoxIntegration) {
    try {
      const creds = await decryptCredentials<{ apiKey: string }>(aimfoxIntegration.encryptedCredentials);
      const apiKey = creds.apiKey;

      const response = await fetch(`https://api.aimfox.io/v1/campaigns/${campaignId}/leads`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          linkedin_url: prospect.linkedInUrl,
          connection_note: msgOutput.connectionNote,
          first_name: prospect.firstName,
          last_name: prospect.lastName ?? "",
          company: prospect.company,
          custom_messages: {
            message_1: msgOutput.message1,
            message_2: msgOutput.message2,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => `HTTP ${response.status}`);
        throw new Error(`Aimfox API returned ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as { id: string; status: string };
      aimfoxLeadId = data.id;
      output.source = "aimfox_live";
      output.aimfoxStatus = data.status;
    } catch (err) {
      // API call failed — fall back to simulation
      aimfoxLeadId = `aimfox_${prospect.id.slice(-8)}_${Date.now()}`;
      output.source = "simulation";
      output.aimfoxError = err instanceof Error ? err.message : String(err);
      output.simulationNote = "Aimfox API call failed — see aimfoxError for details";
    }
  } else {
    // No integration configured — simulate
    aimfoxLeadId = `aimfox_${prospect.id.slice(-8)}_${Date.now()}`;
    output.source = "simulation";
    output.simulationNote = "Connect Aimfox integration in Settings to submit leads to live LinkedIn campaigns";
  }

  output.aimfoxLeadId = aimfoxLeadId;

  await prisma.outboundProspect.update({
    where: { id: prospectId },
    data: { aimfoxLeadId },
  });

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
