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

async function callAimfoxMcp(
  accessToken: string,
  tool: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  // Aimfox uses MCP over HTTP (https://mcp.aimfox.com) — no traditional REST API
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const mcpClient = new Client({ name: "marketing-erp", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.aimfox.com"), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  await mcpClient.connect(transport);
  try {
    const result = await mcpClient.callTool({ name: tool, arguments: params });
    return (result as { content?: unknown; result?: unknown }) as Record<string, unknown>;
  } finally {
    await mcpClient.close();
  }
}

export const outboundLinkedinHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
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
  let aimfoxLeadId: string;
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

  if (aimfoxIntegration) {
    try {
      const creds = await decryptCredentials<{ accessToken: string }>(
        aimfoxIntegration.encryptedCredentials
      );
      // Aimfox exposes LinkedIn automation via MCP — no REST API
      const result = await callAimfoxMcp(creds.accessToken, "add_profile_to_campaign", {
        campaign_id: campaignId,
        profile_url: prospect.linkedInUrl,
        custom_variables: {
          connection_note: msgOutput.connectionNote,
          message_1: msgOutput.message1,
          message_2: msgOutput.message2,
        },
      });
      aimfoxLeadId = (result as { id?: string }).id ?? `aimfox_mcp_${prospect.id.slice(-8)}`;
      output.source = "aimfox_live";
      output.mcpResult = result;
    } catch (err) {
      aimfoxLeadId = `aimfox_${prospect.id.slice(-8)}_${Date.now()}`;
      output.source = "simulation";
      output.aimfoxError = err instanceof Error ? err.message : String(err);
      output.simulationNote = "Aimfox MCP call failed — see aimfoxError. Reconnect via Settings → Integrations → Aimfox.";
    }
  } else {
    aimfoxLeadId = `aimfox_${prospect.id.slice(-8)}_${Date.now()}`;
    output.source = "simulation";
    output.simulationNote = "Connect Aimfox via Settings → Integrations → Aimfox (uses MCP OAuth, not a REST API key)";
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
