import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const communityHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const subreddits = String(config.subreddits ?? "");
  const keywords = String(config.keywords ?? "");
  const answerStyle = String(config.answerStyle ?? "Expert");
  const dailyLimit = Number(config.dailyLimit ?? 5);
  const includeSubtleProof = config.includeSubtleProof === true;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.competitors?.length
          ? `Competitors: ${businessProfile.competitors.join(", ")}`
          : "",
      ].filter(Boolean).join("\n")
    : "";

  const systemPrompt = [
    "You are a community engagement specialist.",
    "Every answer must provide genuine value without promotional intent.",
    "Answers that add real insight build authority.",
    "Respond ONLY with valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Generate ${dailyLimit} community engagement opportunities on Reddit and/or Quora.`,
    subreddits ? `Target subreddits: ${subreddits}` : "Identify relevant subreddits based on the business profile.",
    keywords ? `Focus keywords/topics: ${keywords}` : "",
    `Answer style: ${answerStyle}`,
    includeSubtleProof
      ? "Where natural, include subtle social proof (e.g. 'In my experience working with X type of business…') — never overt promotion."
      : "Keep answers purely educational with no promotional language whatsoever.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      opportunities: [
        {
          platform: "Reddit | Quora",
          thread: {
            title: "Thread or question title",
            url: "https://reddit.com/r/...",
            subreddit: "subreddit name",
            questionSummary: "Brief summary of what the OP is asking",
            estimatedViews: 0,
            relevanceScore: 0,
          },
          draftAnswer: {
            body: "Full draft answer text",
            format: "direct | story | listicle",
            wordCount: 0,
            selfPromotionLevel: "none | subtle | moderate",
            postingNote: "Any note about timing, account age requirements, or posting tips",
          },
        },
      ],
      simulationNote:
        "Connect Reddit integration in Settings to surface real trending threads",
    }),
  ].filter(Boolean).join("\n");

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

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  // claude-haiku-4-5-20251001 pricing: $0.8/M input, $4/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
