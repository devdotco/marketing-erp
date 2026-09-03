import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const metaPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const platforms = (config.platforms as string) ?? "Both";
  const postingFrequency = (config.postingFrequency as string) ?? "3x week";
  const contentStyle = (config.contentStyle as string) ?? "Mixed";
  const hashtagStrategy = (config.hashtagStrategy as string) ?? "Mixed";
  const batchSize = typeof config.batchSize === "number" ? config.batchSize : 7;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are a Meta social media strategist specialising in Facebook and Instagram content. Write distinct content optimised per surface (feed, story, reel) with appropriate tone, length, and CTA for each. Feed posts can be longer and educational. Stories are punchy and visual. Reels scripts are hook-first and direct. Respond ONLY with valid JSON — no markdown, no explanations.`;

  const userPrompt = `Generate a batch of ${batchSize} Meta posts for ${businessProfile?.businessName ?? "the client"}.

Business context:
- Industry: ${businessProfile?.industry ?? "General"}
- Value proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
- Target audience: ${businessProfile?.targetAudience ?? "Not specified"}
- Competitors: ${(businessProfile?.competitors ?? []).join(", ") || "Not specified"}

Publishing config:
- Platforms: ${platforms}
- Posting frequency: ${postingFrequency}
- Content style: ${contentStyle}
- Hashtag strategy: ${hashtagStrategy}

Distribute the ${batchSize} posts across Facebook and Instagram, and across feed/story/reel surfaces as appropriate. Schedule them starting from today, spread across the posting frequency.

Return exactly this JSON structure:
{
  "posts": [
    {
      "platform": "Facebook" | "Instagram",
      "surface": "feed" | "story" | "reel",
      "caption": "full caption text",
      "hashtags": ["hashtag1"],
      "callToAction": "e.g. Link in bio / Comment below / DM us",
      "visualBrief": "description of the ideal image or video for this post",
      "scheduledFor": "ISO 8601 date string",
      "charCount": 0
    }
  ],
  "batchSize": ${batchSize},
  "simulationNote": "Connect Meta integration in Settings to auto-schedule these posts via Meta Graph API"
}`;

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

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};
