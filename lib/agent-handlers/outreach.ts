import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const outreachHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const pitchAngle = String(config.pitchAngle ?? "");
  const sequenceLength = Number(config.sequenceLength ?? 3);
  const followUpDays = Number(config.followUpDays ?? 3);
  const dailyLimit = Number(config.dailyLimit ?? 20);
  const emailAccount = String(config.emailAccount ?? "Gmail");
  const personalisation = String(config.personalisation ?? "High");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.brandVoice ? `Brand voice: ${businessProfile.brandVoice}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const systemPrompt = [
    "You are a link building outreach specialist who writes cold emails that actually get replies.",
    "Emails must be short (under 100 words for the initial pitch), specific (reference something real about the prospect), and genuine (no fake compliments).",
    "Subject lines are intriguing, not clickbait. Follow-ups add value — they don't just ask 'did you see my last email?'",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const sendDelayLabel = (step: number) =>
    step === 1 ? "Send immediately" : `+${(step - 1) * followUpDays} day${(step - 1) * followUpDays === 1 ? "" : "s"}`;

  const exampleSequence = Array.from({ length: sequenceLength }, (_, i) => ({
    sequenceStep: i + 1,
    sendDelay: sendDelayLabel(i + 1),
    subject: i === 0 ? "Initial subject line" : `Follow-up ${i} subject line`,
    body: "Email body text",
    wordCount: 0,
    personalisationNotes: "What was personalised and why",
  }));

  const userPrompt = [
    `Write link building outreach email sequences for ${dailyLimit} prospects per day.`,
    `Sequence length: ${sequenceLength} emails per prospect, with ${followUpDays}-day gaps between follow-ups.`,
    `Personalisation level: ${personalisation}`,
    `Sending account: ${emailAccount}`,
    pitchAngle ? `Pitch angle / value offer: ${pitchAngle}` : "",
    "",
    "Generate sequences for at least 5 representative prospects across different site types (blog, resource page, news site, directory, niche community).",
    "Each email body must be plain text — no HTML, no excessive formatting. Initial emails must be under 100 words.",
    "Follow-up emails should acknowledge the previous email briefly and add a new angle or piece of value.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      sequences: [
        {
          prospectDomain: "example.com",
          prospectName: null,
          emails: exampleSequence,
          pitchAngle: "The specific angle used for this prospect",
        },
      ],
      dailyVolume: dailyLimit,
      simulationNote:
        "Connect Gmail or Microsoft 365 in Settings to send these sequences directly. All follow-ups pause automatically on reply.",
    }),
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { rawText };
  } catch {
    output = { rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  // Sonnet 5 pricing: $3/M input, $15/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
