import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const xEngagerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  // Old names from before the form and handler were reconciled — see renamed-inputs.ts.
  applyRenamedInputs(run, config, {
    replyTone: "replyStyle",
    repliesPerRun: ["maxRepliesPerHour", "dailyLimit"],
    requireApproval: "requireHumanApproval",
  });

  const monitorKeywords = lines(config, "monitorKeywords", 30);
  const competitorHandles = lines(config, "competitorHandles", 20);
  const avoidTopics = lines(config, "avoidTopics", 30);
  const replyTone = str(config, "replyTone", "Conversational");
  const relevanceThreshold = str(config, "relevanceThreshold", "Medium");
  const minAuthorFollowers = num(config, "minAuthorFollowers", 1000, { min: 0 });
  // Capped so the drafted batch fits the 4096-token response below.
  const repliesPerRun = Math.round(num(config, "repliesPerRun", 10, { min: 1, max: 20 }));

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const toneGuide: Record<string, string> = {
    Analytical: "adds a fact, stat, or framework the original missed",
    Conversational: "sounds like a peer joining the thread, plain and specific",
    Challenging: "respectfully challenges the premise with evidence",
    Supportive: "amplifies the point with a specific real-world example",
  };

  const systemPrompt = `You are an X (Twitter) engagement analyst and reply drafter for ${
    (businessProfile as any)?.companyName ?? "a business"
  }.
You score posts for genuine relevance and draft replies/quote-posts that add real substance.
Every reply must contribute new information, a distinct perspective, or a compelling question — no hollow agreement.
Reply tone: ${replyTone}
Relevance threshold: ${relevanceThreshold}
${avoidTopics.length > 0 ? `Brand safety: never engage with, draft for, or mention these topics — skip any post touching them: ${avoidTopics.join(", ")}.` : ""}
Always respond with ONLY a valid JSON object — no markdown fences, no extra prose.`;

  const userPrompt = `Simulate monitoring X for the conversations below and draft ${repliesPerRun} engagement actions for today.

Keywords and hashtags to track:
${monitorKeywords.length > 0 ? monitorKeywords.join(", ") : "Topics central to the business context below"}
${competitorHandles.length > 0 ? `\nCompetitor handles (threads they post, and conversations mentioning them, are engagement opportunities — never disparage them):\n${competitorHandles.join(", ")}\n` : ""}
Only engage with posts whose author has at least ${minAuthorFollowers.toLocaleString("en-US")} followers.

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

Reply tone: ${replyTone} — ${toneGuide[replyTone] ?? toneGuide.Conversational}

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
      "matchedOn": "the keyword or competitor handle this post was found by",
      "relevanceScore": 0.87,
      "relevanceReason": "directly discusses our core topic",
      "actionRecommended": "reply|quotePost|like",
      "draftedReply": {
        "text": "drafted reply text (max 280 chars)",
        "characterCount": 218,
        "replyTone": "${replyTone}",
        "valueAdded": "what new perspective or data this reply contributes",
        "estimatedImpressions": 3200,
        "approved": false
      },
      "draftedQuotePost": null
    }
  ],
  "skippedPosts": [
    {
      "reason": "below relevance threshold | author below follower minimum | avoided topic",
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
  output.simulationNote =
    "Connect X (Twitter) in Settings to pull live list feeds, real impression data, and enable one-click reply";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { output, costUsd };
};
