import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const metaAdsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const campaignObjective = (config.campaignObjective as string) ?? "Leads";
  const audienceTemp = (config.audienceTemp as string) ?? "All";
  const creativeBatchSize = (config.creativeBatchSize as number) ?? 3;
  const budgetUsd = (config.budgetUsd as number) ?? 1000;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are an expert Meta Ads creative strategist specializing in Facebook and Instagram advertising. You create high-converting ad creative concepts for static images, video scripts, carousel ads, and story formats. You understand audience temperature—cold audiences need pattern interrupts and education, warm audiences need social proof and urgency, retargeting audiences need objection handling and direct offers. You know what hooks stop the scroll, what social proof closes, and how to structure creative for Meta's auction dynamics.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const userPrompt = `Generate a comprehensive Meta Ads creative brief and strategy for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Value Proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
Target Audience: ${businessProfile?.targetAudience ?? "Not specified"}
Brand Voice: ${businessProfile?.brandVoice ?? "Not specified"}

Campaign Configuration:
- Objective: ${campaignObjective}
- Audience Temperature Focus: ${audienceTemp}
- Creative Variants Per Format: ${creativeBatchSize}
- Total Budget: $${budgetUsd}

Generate ${creativeBatchSize} creative variants per format (static, video, carousel, story), calibrated to the audience temperature. If audienceTemp is "All", generate variants for each temperature within each format.

Return a JSON object with this structure:
{
  "budgetAllocation": {
    "totalBudget": number,
    "byAudienceTemp": [
      { "temperature": string, "percentage": number, "dailyBudget": number, "monthlyBudget": number, "rationale": string }
    ],
    "campaignStructure": string,
    "biddingStrategy": string
  },
  "audienceDefinitions": [
    {
      "temperature": string,
      "segmentName": string,
      "facebookAudienceType": string,
      "interests": [string],
      "behaviors": [string],
      "demographics": { "ageRange": string, "gender": string, "location": string },
      "lookalike": string,
      "customAudience": string,
      "exclusions": [string],
      "estimatedReach": string,
      "estimatedCPM": string,
      "estimatedCPC": string
    }
  ],
  "creatives": {
    "static": [
      {
        "variantId": string,
        "audienceTemp": string,
        "angle": string,
        "hook": string,
        "primaryText": string,
        "headline": string,
        "description": string,
        "cta": string,
        "imageDirection": { "style": string, "subject": string, "colorPalette": string, "textOverlay": string, "format": string },
        "emotionalTrigger": string
      }
    ],
    "video": [
      {
        "variantId": string,
        "audienceTemp": string,
        "angle": string,
        "hook": string,
        "scriptOutline": [{ "timestamp": string, "content": string, "visualNote": string }],
        "supers": [string],
        "primaryText": string,
        "headline": string,
        "cta": string,
        "duration": string,
        "captionsRequired": boolean
      }
    ],
    "carousel": [
      {
        "variantId": string,
        "audienceTemp": string,
        "angle": string,
        "overallNarrative": string,
        "cards": [
          { "cardNumber": number, "headline": string, "body": string, "imageDirection": string, "cta": string }
        ],
        "primaryText": string,
        "finalCardCta": string
      }
    ],
    "story": [
      {
        "variantId": string,
        "audienceTemp": string,
        "angle": string,
        "frame1": { "visual": string, "text": string, "duration": string },
        "frame2": { "visual": string, "text": string, "duration": string },
        "frame3": { "visual": string, "text": string, "duration": string },
        "swipeUpCta": string,
        "tapTarget": string
      }
    ]
  },
  "testingFramework": {
    "phase1": {
      "focus": string,
      "variants": [string],
      "budget": string,
      "kpi": string,
      "duration": string,
      "winnerCriteria": string
    },
    "phase2": {
      "focus": string,
      "variants": [string],
      "budget": string,
      "kpi": string,
      "duration": string,
      "winnerCriteria": string
    },
    "scalingPlaybook": string
  }
}`;

  const message = await client.messages.create({
    model: MODELS.standard,
    max_tokens: 8096,
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
    "Connect Meta Business API in Settings to enable live audience sizing, real CPM benchmarks, ad account performance data, and automated creative scoring";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};
