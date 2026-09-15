import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { bool, num, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const metaAdsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const campaignObjective = str(config, "campaignObjective", "Leads");
  const audienceTemp = str(config, "audienceTemp", "All");
  const creativeBatchSize = num(config, "creativeBatchSize", 3, { min: 1, max: 5 });
  const budgetUsd = num(config, "budgetUsd", 1000, { min: 0 });
  // No Meta ad account is connected to this agent, so these are the rules the
  // plan hands the media buyer — not thresholds checked against live data.
  const attributionWindow = str(config, "optimizationWindow", "7-day click");
  const fatigueFrequency = num(config, "fatigueFrequencyThreshold", 3.5, { min: 1 });
  const roasDropPct = num(config, "roasDropThreshold", 15, { min: 1, max: 100 });
  const reallocationCapPct = num(config, "budgetReallocationCap", 30, { min: 1, max: 100 });
  const brandVoiceNotes = str(config, "brandVoiceNotes");
  const includeReels = bool(config, "includeReelsPlacements", true);

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
${brandVoiceNotes ? `Copy Guardrails (follow these in every line of copy): ${brandVoiceNotes}\n` : ""}
Campaign Configuration:
- Objective: ${campaignObjective}
- Audience Temperature Focus: ${audienceTemp}
- Creative Variants Per Format: ${creativeBatchSize}
- Total Budget: $${budgetUsd}
- Attribution Window for judging results: ${attributionWindow}

Generate ${creativeBatchSize} creative variants per format (static, video, carousel, story), calibrated to the audience temperature. If audienceTemp is "All", generate variants for each temperature within each format.
${includeReels ? "The story variants must also work as Reels: hook in the first second, vertical 9:16, and a Reels-specific primary text; set reelsReady to true on each." : "Story variants are for Stories only; set reelsReady to false."}

Optimization rules the plan must state in testingFramework.optimizationRules, using exactly these thresholds:
- Refresh creative when an ad's frequency exceeds ${fatigueFrequency}.
- Flag an ad set for creative refresh when week-over-week ROAS drops by ${roasDropPct}% or more, regardless of frequency.
- Never shift more than ${reallocationCapPct}% of an ad set's budget in a single reallocation.
- Judge test winners on the ${attributionWindow} attribution window.

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
        "tapTarget": string,
        "reelsReady": boolean
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
    "scalingPlaybook": string,
    "optimizationRules": [{ "rule": string, "threshold": string, "action": string }]
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
