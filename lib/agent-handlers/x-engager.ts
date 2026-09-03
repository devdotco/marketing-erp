import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const xEngagerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const monitoredLists = (config.monitoredLists as string) ?? "";
  const relevanceThreshold = (config.relevanceThreshold as string) ?? "Medium";
  const replyStyle = (config.replyStyle as string) ?? "Informative";
  const dailyLimit = (config.dailyLimit as number) ?? 15;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are an X (Twitter) engagement analyst and reply drafter for ${
    (businessProfile as any)?.companyName ?? "a business"
  }.
You monitor X lists, score posts for genuine relevance, and draft replies/quote-posts that add real substance.
Every reply must contribute new information, a distinct perspective, or a compelling question — no hollow agreement.
Reply style: ${replyStyle}
Relevance threshold: ${relevanceThreshold}
Always respond with ONLY a valid JSON object — no markdown fences, no extra prose.`;

  const userPrompt = `Simulate monitoring the following X lists and draft ${dailyLimit} engagement actions for today.

Monitored X lists:
${monitoredLists || "Founders, Marketing Leaders, Industry Analysts, Venture Capital, Tech Journalists"}

Business context:
- Company: ${(businessProfile as any)?.companyName ?? "Our Business"}
- Industry: ${(businessProfile as any)?.industry ?? "Business Services"}
- Expertise areas: ${(businessProfile as any)?.keyOfferings ?? "Strategy, operations, growth"}
- Brand voice: ${(businessProfile as any)?.brandVoice ?? "Authoritative yet approachable"}

Relevance threshold: ${relevanceThreshold} (${
    relevanceThreshold === "High"
      ? "only posts directly in our niche"
      : relevanceThreshold === "Medium"
      ? "posts adjacent to our domain with engagement potential"
      : "broad industry posts where we can add value"
  })

Reply style: ${replyStyle}
- Informative: adds a fact, stat, or framework the original missed
- Contrarian: respectfully challenges the premise with evidence
- Supportive: amplifies with a specific real-world example

Return exactly this JSON shape:
{
  "monitoredFeed": [
    {
      "postId": "sim_post_1",
      "authorHandle": "@thought_leader",
      "authorFollowers": 48200,
      "postText": "full simulated post text being engaged with",
      "postImpressions": 22400,
      "postEngagementRate": 3.1,
      "postedAt": "2024-01-15T09:30:00Z",
      "sourceList": "Founders",
      "relevanceScore": 0.87,
      "relevanceReason": "directly discusses our core topic",
      "actionRecommended": "reply|quotePost|like",
      "draftedReply": {
        "text": "drafted reply text (max 280 chars)",
        "characterCount": 218,
        "replyStyle": "${replyStyle}",
        "valueAdded": "what new perspective or data this reply contributes",
        "estimatedImpressions": 3200,
        "approved": false
      },
      "draftedQuotePost": null
    }
  ],
  "skippedPosts": [
    {
      "reason": "below relevance threshold",
      "count": 34
    }
  ],
  "dailyStats": {
    "postsScanned": 180,
    "postsAboveThreshold": 15,
    "repliesDrafted": 10,
    "quotePostsDrafted": 5,
    "estimatedTotalImpressions": 48000,
    "estimatedFollowerGrowth": 12
  },
  "topOpportunity": {
    "reason": "why this is the highest-priority engagement today",
    "postId": "sim_post_1"
  }
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
    "Connect X (Twitter) in Settings to pull live list feeds, real impression data, and enable one-click reply";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
