import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const youtubeHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const channelUrl = (config.channelUrl as string) ?? "";
  const videoCount = typeof config.videoCount === "number" ? config.videoCount : 5;
  const metaStyle = (config.metaStyle as string) ?? "Balanced";
  const commentSweepDays = typeof config.commentSweepDays === "number" ? config.commentSweepDays : 7;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are a YouTube SEO specialist. Write descriptions that front-load keywords in the first 2 lines (for above-fold display). Chapters should aid watch time by grouping content clearly. Comment replies build community — they sound like a knowledgeable team member, not a PR firm. Respond ONLY with valid JSON — no markdown, no code fences.`;

  const userPrompt = `Generate YouTube optimisation for ${videoCount} videos for ${businessProfile?.businessName ?? "the client"}.

Business context:
- Industry: ${businessProfile?.industry ?? "General"}
- Value proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
- Target audience: ${businessProfile?.targetAudience ?? "Not specified"}
- Channel URL: ${channelUrl || "Not specified"}

Configuration:
- Meta style: ${metaStyle} (SEO-first = keyword-dense, Click-first = curiosity/hook, Balanced = both)
- Comment sweep period: ${commentSweepDays} days

For each of the ${videoCount} videos, generate realistic placeholder optimisation based on the business context. Also generate 5 sample comment replies spanning different sentiment types.

Return exactly this JSON structure:
{
  "videoOptimizations": [
    {
      "videoUrl": "placeholder URL or inferred from channel",
      "titleOptions": ["Option A", "Option B", "Option C"],
      "description": "Full YouTube description with keywords in first 2 lines, then chapters, then links and CTA",
      "chapters": [
        {"timestamp": "0:00", "title": "Chapter title"}
      ],
      "tags": ["tag1", "tag2"],
      "thumbnailTextSuggestions": ["Text option 1", "Text option 2", "Text option 3"]
    }
  ],
  "commentReplies": [
    {
      "commentText": "Sample viewer comment",
      "suggestedReply": "Reply text",
      "sentiment": "positive" | "neutral" | "negative" | "question"
    }
  ],
  "simulationNote": "Connect YouTube integration in Settings to fetch real video metadata and comment data"
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

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
