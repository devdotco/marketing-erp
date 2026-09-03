import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

const CAMPAIGN_MAP: Record<string, string> = {
  "DEV-01": "DEV-01-SAAS-V1",
  "DEV-02": "DEV-02-AGENCY-V1",
  "DEV-03": "DEV-03-PE-V1",
};

export const outboundEmailHandler: AgentHandler = async (run, updateStatus) => {
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
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let variableOutput: Record<string, unknown>;
  try {
    variableOutput = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    variableOutput = {};
  }

  const variables = (variableOutput.variables ?? {}) as Record<string, string>;
  const campaignId = (variableOutput.campaignId ?? CAMPAIGN_MAP[prospect.play.slug] ?? "DEV-01-SAAS-V1") as string;

  let instantlyLeadId: string;
  let source: string;
  let simulationNote: string | undefined;

  if (instantlyIntegration) {
    const credentials = await decryptCredentials<{ apiKey: string }>(instantlyIntegration.encryptedCredentials);

    const body = {
      campaign_id: campaignId,
      email: prospect.email,
      first_name: prospect.firstName,
      last_name: prospect.lastName ?? "",
      company_name: prospect.company,
      personalization: variables.pain_signal ?? "",
      custom_variables: {
        pain_signal: variables.pain_signal ?? "",
        trigger: variables.trigger ?? "",
        offer_angle: variables.offer_angle ?? "",
        company_context: variables.company_context ?? "",
        proof_point: variables.proof_point ?? "",
      },
    };

    const response = await fetch("https://api.instantly.ai/api/v1/lead/add", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Instantly API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as { status: string; data: { id: string } };
    instantlyLeadId = data.data.id;
    source = "instantly_live";
  } else {
    // Simulation mode — no Instantly integration configured
    instantlyLeadId = `instantly_${prospect.id.slice(-8)}_${Date.now()}`;
    source = "simulation";
    simulationNote = "Connect Instantly integration in Settings to submit leads to live campaigns via the Instantly REST API";
  }

  await prisma.outboundProspect.update({
    where: { id: prospectId },
    data: {
      instantlyLeadId,
      status: "IN_SEQUENCE",
    },
  });

  const output: Record<string, unknown> = {
    prospectId,
    firstName: prospect.firstName,
    company: prospect.company,
    email: prospect.email,
    campaignId,
    instantlyLeadId,
    variables: variableOutput.variables,
    qualityNotes: variableOutput.qualityNotes,
    source,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
  };

  if (simulationNote !== undefined) {
    output.simulationNote = simulationNote;
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
