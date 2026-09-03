import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const socialListeningHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const brandKeywords = (config.brandKeywords as string) ?? "";
  const competitors = (config.competitors as string) ?? "";
  const platforms = (config.platforms as string) ?? "All";
  const sentimentAlert = config.sentimentAlert !== false;
  const digestFrequency = (config.digestFrequency as string) ?? "Daily";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are a brand monitoring analyst. Flag anything requiring urgent response (negative viral content, product issues, PR risks) separately from routine mentions. Draft suggested replies that sound like a knowledgeable human, not a PR agency. Respond ONLY with valid JSON — no markdown, no code fences.`;

  const userPrompt = `Generate a ${digestFrequency.toLowerCase()} brand monitoring digest for ${businessProfile?.businessName ?? "the client"}.

Business context:
- Industry: ${businessProfile?.industry ?? "General"}
- Value proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
- Target audience: ${businessProfile?.targetAudience ?? "Not specified"}

Monitoring configuration:
- Brand keywords: ${brandKeywords || businessProfile?.businessName || "brand name"}
- Competitors to watch: ${competitors || (businessProfile?.competitors ?? []).join(", ") || "None specified"}
- Platforms: ${platforms}
- Sentiment alerts enabled: ${sentimentAlert}
- Digest frequency: ${digestFrequency}

Simulate a realistic monitoring digest based on the business context. Include a mix of mention types and sentiments. Flag anything requiring urgent response.

Return exactly this JSON structure:
{
  "digest": {
    "period": "${digestFrequency} digest — simulated",
    "mentionCount": 0,
    "sentimentBreakdown": { "positive": 0, "neutral": 0, "negative": 0 },
    "topMentions": [
      {
        "platform": "X | Reddit | LinkedIn | Facebook",
        "content": "mention text",
        "author": "username",
        "url": "https://example.com/post",
        "sentiment": "positive | neutral | negative",
        "suggestedReply": "reply text or null",
        "requiresResponse": false
      }
    ],
    "competitorActivity": [
      {
        "competitor": "competitor name",
        "noteworthy": "what they did",
        "implication": "what it means for you"
      }
    ],
    "alerts": [
      {
        "type": "negative_viral | pr_risk | product_issue | competitor_move",
        "message": "alert description",
        "severity": "low | medium | high"
      }
    ]
  },
  "simulationNote": "Connect X and Reddit integrations in Settings to monitor real mentions. This digest is AI-generated based on your brand profile."
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
