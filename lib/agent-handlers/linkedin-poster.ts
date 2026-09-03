import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const linkedinPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const accountType = (config.accountType as string) ?? "Personal Profile";
  const postingFrequency = (config.postingFrequency as string) ?? "3x week";
  const contentPillars = (config.contentPillars as string) ?? "";
  const toneOverride = (config.toneOverride as string) ?? "Use Brand default";
  const batchSize = (config.batchSize as number) ?? 7;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const resolvedTone =
    toneOverride === "Use Brand default"
      ? ((businessProfile as any)?.brandVoice ?? "Professional")
      : toneOverride;

  const horizonLabel =
    postingFrequency === "Daily"
      ? "7 days"
      : postingFrequency === "3x week"
      ? "2.5 weeks"
      : "4 weeks";

  const systemPrompt = `You are an expert LinkedIn content strategist specialising in ${
    (businessProfile as any)?.industry ?? "business"
  }.
Your task is to create a batch of high-performing LinkedIn posts for ${
    accountType === "Company Page" ? "a company LinkedIn page" : "a personal LinkedIn profile"
  }.
Tone/voice: ${resolvedTone}
Company: ${(businessProfile as any)?.companyName ?? "the business"}
Always respond with ONLY a valid JSON object — no markdown fences, no extra prose.`;

  const userPrompt = `Create ${batchSize} LinkedIn posts to distribute over ${horizonLabel}.

Content pillars to draw from:
${contentPillars || "Thought Leadership, Industry Trends, Company Culture, Product Value, Client Success Stories"}

Business context:
- Company: ${(businessProfile as any)?.companyName ?? "Our Business"}
- Industry: ${(businessProfile as any)?.industry ?? "Business Services"}
- Target audience: ${(businessProfile as any)?.targetAudience ?? "Business professionals and decision-makers"}
- Key value proposition: ${(businessProfile as any)?.valueProposition ?? "Delivering exceptional results for clients"}
- Website: ${(businessProfile as any)?.website ?? "https://example.com"}

Return exactly this JSON shape (no other keys at root level):
{
  "posts": [
    {
      "id": "post_1",
      "scheduledDate": "YYYY-MM-DD",
      "scheduledTime": "HH:MM",
      "contentPillar": "string",
      "hook": "first line engineered to stop the scroll — no clickbait",
      "body": "full post body with \\n line breaks between paragraphs",
      "cta": "specific call-to-action sentence",
      "hashtags": ["#Hashtag1", "#Hashtag2", "#Hashtag3"],
      "postFormat": "text|carousel|poll|document|video",
      "mediaNote": "description of accompanying visual or leave empty string",
      "characterCount": 920,
      "estimatedImpressions": 4200,
      "estimatedEngagementRate": 3.6,
      "approved": false
    }
  ],
  "calendarSummary": {
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "totalPosts": 7,
    "pillarsDistribution": { "Thought Leadership": 2, "Industry Trends": 2, "Company Culture": 1, "Product Value": 1, "Client Success": 1 },
    "formatsMix": { "text": 4, "carousel": 2, "poll": 1 }
  },
  "strategyNotes": "2-3 sentences explaining strategic intent and expected outcomes"
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
    "Connect LinkedIn in Settings to enable live scheduling, reach analytics, and auto-publish";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};
