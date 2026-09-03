import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

interface AdsStreamChunk {
  results?: Array<{
    campaign: { name: string };
    metrics: {
      costMicros: string;
      clicks: string;
      impressions: string;
      conversions: number;
    };
  }>;
}

export const googleAdsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const campaignGoal = (config.campaignGoal as string) ?? "Leads";
  const adGroupTheme = (config.adGroupTheme as string) ?? "General";
  const numHeadlines = (config.numHeadlines as number) ?? 15;
  const numDescriptions = (config.numDescriptions as number) ?? 4;
  const negativesReview = (config.negativesReview as boolean) ?? true;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  // --- Live Google Ads Data ---
  let liveAdsData: string | null = null;
  let source = "simulation";

  try {
    const adsIntegration = await prisma.integration.findUnique({
      where: {
        workspaceId_provider: {
          workspaceId: run.agentConfig.workspaceId,
          provider: "GOOGLE_ADS",
        },
      },
    });

    if (adsIntegration?.encryptedCredentials) {
      const creds = await decryptCredentials<{
        access_token: string;
        customer_id: string;
      }>(adsIntegration.encryptedCredentials);

      const customerId = creds.customer_id.replace(/-/g, "");
      const adsRes = await fetch(
        `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:searchStream`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query:
              "SELECT campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS",
          }),
        }
      );

      if (!adsRes.ok) {
        throw new Error(`Google Ads API error: ${adsRes.status}`);
      }

      const chunks = (await adsRes.json()) as AdsStreamChunk[];

      const campaigns: Array<{
        name: string;
        costUsd: number;
        clicks: number;
        impressions: number;
        conversions: number;
      }> = [];

      for (const chunk of chunks) {
        for (const row of chunk.results ?? []) {
          campaigns.push({
            name: row.campaign.name,
            costUsd: Number(row.metrics.costMicros) / 1_000_000,
            clicks: Number(row.metrics.clicks),
            impressions: Number(row.metrics.impressions),
            conversions: Number(row.metrics.conversions),
          });
        }
      }

      liveAdsData = JSON.stringify(campaigns, null, 2);
      source = "live";
    }
  } catch {
    // fall through to simulation
  }

  const systemPrompt = `You are an expert Google Ads copywriter and search marketing strategist. You write RSA (Responsive Search Ad) headlines and descriptions that maximize Quality Score and CTR. You analyze search terms to identify high-value keywords and irrelevant negatives. You understand match types, intent signals, conversion-focused messaging, and spend anomaly detection.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const liveDataBlock = liveAdsData
    ? `\n\nLive Google Ads Campaign Performance (Last 30 Days):\n${liveAdsData}\n\nUse the above real campaign data to ground your RSA recommendations, keyword priorities, and bid strategy rationale. Reference actual campaign names and performance figures in your analysis.`
    : "";

  const userPrompt = `Generate a comprehensive Google Ads RSA, keyword strategy, and search term analysis for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Value Proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
Target Audience: ${businessProfile?.targetAudience ?? "Not specified"}
Location: Not specified

Campaign Configuration:
- Campaign Goal: ${campaignGoal}
- Ad Group Theme: ${adGroupTheme}
- Headlines Needed: ${numHeadlines} (max 30 chars each)
- Descriptions Needed: ${numDescriptions} (max 90 chars each)
- Negative Keywords Review: ${negativesReview}
${liveDataBlock}

Return a JSON object with this exact structure:
{
  "rsa": {
    "headlines": [
      { "text": string, "charCount": number, "pinRecommendation": "1" | "2" | "3" | "any", "strength": "strong" | "medium" | "weak", "category": "keyword" | "benefit" | "cta" | "brand" | "social_proof" }
    ],
    "descriptions": [
      { "text": string, "charCount": number, "focus": "benefit" | "cta" | "differentiator" | "social_proof", "pinRecommendation": "1" | "2" | "any" }
    ],
    "strengthAnalysis": {
      "overallScore": number,
      "pinningStrategy": string,
      "keywordInsertion": boolean,
      "recommendations": [string]
    }
  },
  "keywords": {
    "broad": [{ "keyword": string, "intent": string, "estimatedCPC": string, "estimatedVolume": string, "priority": "high" | "medium" | "low", "adGroupFit": string }],
    "phrase": [{ "keyword": string, "intent": string, "estimatedCPC": string, "estimatedVolume": string, "priority": "high" | "medium" | "low", "adGroupFit": string }],
    "exact": [{ "keyword": string, "intent": string, "estimatedCPC": string, "estimatedVolume": string, "priority": "high" | "medium" | "low", "adGroupFit": string }]
  },
  "negativeKeywords": {
    "campaign": [{ "keyword": string, "matchType": "exact" | "phrase" | "broad", "reason": string }],
    "adGroup": [{ "keyword": string, "matchType": "exact" | "phrase" | "broad", "reason": string }]
  },
  "spendAnomalyAlerts": [
    { "alertType": string, "severity": "critical" | "warning" | "info", "description": string, "threshold": string, "recommendedAction": string, "automationRule": string }
  ],
  "searchTermInsights": {
    "highValueOpportunities": [
      { "term": string, "intent": "commercial" | "informational" | "transactional" | "navigational", "suggestedMatchType": string, "suggestedAdGroup": string, "suggestedAction": string }
    ],
    "wastedSpendRisks": [
      { "term": string, "issue": string, "estimatedWastedSpend": string, "suggestedNegative": string, "negativeLevel": "campaign" | "adGroup" }
    ]
  },
  "bidStrategy": {
    "recommended": string,
    "targetCPA": string,
    "targetROAS": string,
    "rationale": string,
    "transitionPlan": string
  }
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
  output.source = source;

  if (source === "simulation") {
    output.simulationNote =
      "Connect Google Ads API in Settings to enable live search term data, real Quality Scores, spend anomaly monitoring, and automated negative keyword management";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};
