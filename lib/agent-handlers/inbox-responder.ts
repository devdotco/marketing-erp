import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const inboxResponderHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const emailAccount = (config.emailAccount as string) ?? "Gmail";
  const autoCategories = (config.autoCategories as string) ?? "All";
  const draftReplyStyle = (config.draftReplyStyle as string) ?? "Professional";
  const flagKeywords = (config.flagKeywords as string) ?? "Not specified";
  const dailyBatchSize = (config.dailyBatchSize as number) ?? 20;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are an executive email assistant. Distinguish genuine business inquiries from mass outreach. Never draft a reply to an obvious pitch. Flag emails that might be time-sensitive even if they seem routine (finance, legal, from existing clients). All drafted replies stay as drafts — never send autonomously.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const userPrompt = `Simulate processing an inbox batch for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Website: ${businessProfile?.websiteUrl ?? "Not specified"}
Target Audience: ${businessProfile?.targetAudience ?? "Not specified"}
Brand Voice: ${businessProfile?.brandVoice ?? "Not specified"}
Goals: ${businessProfile?.goals ? JSON.stringify(businessProfile.goals) : "Not specified"}

Inbox Configuration:
- Email Account: ${emailAccount}
- Categories to Process: ${autoCategories}
- Draft Reply Style: ${draftReplyStyle}
- Flag Keywords: ${flagKeywords}
- Daily Batch Size: ${dailyBatchSize}

Since no live inbox is connected, simulate a realistic batch of ${dailyBatchSize} emails for this business type. Generate a realistic mix of genuine inquiries, pitches, flagged emails, newsletters, and automated messages. Draft replies only for genuineInquiries where requiresHumanReview is false.

Return a JSON object with this exact structure:
{
  "processed": number,
  "categories": {
    "genuineInquiries": [
      {
        "subject": string,
        "from": string,
        "summary": string,
        "urgency": "high" | "medium" | "low",
        "category": string,
        "draftReply": string,
        "requiresHumanReview": boolean,
        "suggestedAction": string
      }
    ],
    "pitches": [
      {
        "subject": string,
        "from": string,
        "summary": string,
        "recommendation": "ignore" | "decline" | "consider"
      }
    ],
    "flagged": [
      {
        "subject": string,
        "from": string,
        "reason": string,
        "suggestedAction": string
      }
    ],
    "newsletters": number,
    "automated": number
  },
  "draftsCreated": number,
  "simulationNote": "Connect Gmail or Microsoft 365 in Settings to process real inbox messages. All drafts require your review before sending."
}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  output.simulationNote =
    "Connect Gmail or Microsoft 365 in Settings to process real inbox messages. All drafts require your review before sending.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
