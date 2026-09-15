import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { bool, lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const communityHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  // Old names from before the form and handler were reconciled — see renamed-inputs.ts.
  applyRenamedInputs(run, config, {
    monitorSubreddits: "subreddits",
    monitorKeywords: "keywords",
    repliesPerRun: ["maxRepliesPerWeek", "dailyLimit"],
  });
  const subreddits = lines(config, "monitorSubreddits", 20).join(", ");
  const keywords = lines(config, "monitorKeywords", 30).join(", ");
  const answerStyle = str(config, "answerStyle", "Expert");
  // Capped so the drafted batch fits the 4096-token response below.
  const dailyLimit = Math.round(num(config, "repliesPerRun", 5, { min: 1, max: 10 }));
  const includeSubtleProof = bool(config, "includeSubtleProof", false);
  const includeHackerNews = bool(config, "includeHackerNews", true);
  const brandMentionAlerts = bool(config, "brandMentionAlerts", true);
  const platforms = includeHackerNews ? "Reddit, Quora, and/or Hacker News" : "Reddit and/or Quora";

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
    `Generate ${dailyLimit} community engagement opportunities on ${platforms}.`,
    includeHackerNews ? "" : "Do not include Hacker News threads.",
    subreddits ? `Target subreddits: ${subreddits}` : "Identify relevant subreddits based on the business profile.",
    keywords ? `Focus keywords/topics: ${keywords}` : "",
    `Answer style: ${answerStyle}`,
    brandMentionAlerts && businessProfile?.businessName
      ? `List threads that mention ${businessProfile.businessName}${businessProfile.websiteUrl ? ` or ${businessProfile.websiteUrl}` : ""} by name first, marked brandMention: true, ahead of keyword matches.`
      : "",
    includeSubtleProof
      ? "Where natural, include subtle social proof (e.g. 'In my experience working with X type of business…') — never overt promotion."
      : "Keep answers purely educational with no promotional language whatsoever.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      opportunities: [
        {
          platform: includeHackerNews ? "Reddit | Quora | Hacker News" : "Reddit | Quora",
          brandMention: false,
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
    model: MODELS.fast,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
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
  // Priced from lib/ai/models.ts — Haiku 4.5 is $1/M input, $5/M output.
  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { output, costUsd };
};
