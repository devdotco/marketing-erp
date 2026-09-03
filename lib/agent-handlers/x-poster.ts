import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const xPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const contentSeed = (config.contentSeed as string) ?? "";
  const postType = (config.postType as string) ?? "Standalone";
  const threadLength = (config.threadLength as number) ?? 6;
  const postingFrequency = (config.postingFrequency as string) ?? "3x week";
  const batchSize = (config.batchSize as number) ?? 7;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const horizonDays =
    postingFrequency === "Daily" ? 7 : postingFrequency === "3x week" ? 17 : 28;

  const systemPrompt = `You are an elite X (Twitter) content strategist for ${
    (businessProfile as any)?.companyName ?? "a business"
  } in the ${(businessProfile as any)?.industry ?? "business"} space.
You write posts that lead with the conclusion, pack insight per word, and never pad.
Thread rule: tweet 1 must contain the full thesis — the rest amplify, prove, or nuance.
Always respond with ONLY a valid JSON object — no markdown fences, no extra prose.`;

  const userPrompt = `Generate a ${batchSize}-post X content batch (post type: ${postType}) for the next ${horizonDays} days.

Content seed / ideas:
${contentSeed || "Share contrarian takes on industry trends, tactical how-tos, hot-takes backed by data, and company milestones"}

Business context:
- Company: ${(businessProfile as any)?.companyName ?? "Our Business"}
- Industry: ${(businessProfile as any)?.industry ?? "Business Services"}
- Target audience on X: ${(businessProfile as any)?.targetAudience ?? "Founders, operators, and industry professionals"}
- Value prop: ${(businessProfile as any)?.valueProposition ?? "Cutting through noise with real expertise"}

Post type: ${postType}
${postType === "Thread" ? `Thread length: ${threadLength} tweets per thread` : ""}
${postType === "Reply" ? "Draft replies to hypothetical high-impression posts in our niche" : ""}
${postType === "Quote" ? "Draft quote-posts that add a distinct layer of commentary" : ""}

Return exactly this JSON shape:
{
  "posts": [
    {
      "id": "x_post_1",
      "postType": "${postType}",
      "scheduledDate": "YYYY-MM-DD",
      "scheduledTime": "HH:MM",
      "topic": "concise topic label",
      "tweets": [
        {
          "tweetNumber": 1,
          "text": "tweet text (max 280 chars)",
          "characterCount": 240,
          "isThread": false,
          "mediaNote": "optional image/gif description"
        }
      ],
      "threadThesis": "one-sentence core argument (for threads)",
      "estimatedImpressions": 8400,
      "estimatedEngagementRate": 2.8,
      "estimatedReplies": 14,
      "estimatedReposts": 32,
      "approved": false,
      "tags": ["#IndustryTag"]
    }
  ],
  "weeklyDistribution": {
    "Monday": 1, "Tuesday": 1, "Wednesday": 1, "Thursday": 1, "Friday": 1, "Saturday": 0, "Sunday": 0
  },
  "contentThemes": ["theme1", "theme2"],
  "strategyNotes": "2-3 sentences on the strategic intent and expected growth outcomes"
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
  output.simulationNote =
    "Connect X (Twitter) in Settings to enable live scheduling, impression tracking, and auto-publish";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};
