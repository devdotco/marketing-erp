import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { googleCredentials, liveCallFailed } from "@/lib/integrations/google";
import { googleAdsSearchStream, parseGoogleAdsAccountValue } from "@/lib/integrations/google-ads";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { bool, num, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

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

/** GAQL date clause for the audit window — the predefined ranges where one matches, else an explicit span ending yesterday. */
function gaqlDateClause(days: number): string {
  if (days === 7 || days === 14 || days === 30) return `segments.date DURING LAST_${days}_DAYS`;
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(end.getDate() - (days - 1));
  return `segments.date BETWEEN '${fmt(start)}' AND '${fmt(end)}'`;
}

const CHANNEL_TYPE_FILTER: Record<string, string> = {
  "Search Only": "SEARCH",
  "Shopping Only": "SHOPPING",
  "Performance Max Only": "PERFORMANCE_MAX",
};

export const googleAdsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const campaignGoal = str(config, "campaignGoal", "Leads");
  const adGroupTheme = str(config, "adGroupTheme", "General");
  // RSA hard limits: 3-15 headlines, 2-4 descriptions.
  const numHeadlines = num(config, "numHeadlines", 15, { min: 3, max: 15 });
  const numDescriptions = num(config, "numDescriptions", 4, { min: 2, max: 4 });
  const negativesReview = bool(config, "includeNegativeKeywords", true);
  const accountId = ((config.accountId as string) ?? "").replace(/-/g, "");
  const auditWindowDays = num(config, "auditWindowDays", 30, { min: 1, max: 365 });
  const primaryConversionAction = str(config, "primaryConversionAction");
  const minImpressions = num(config, "minImpressions", 100, { min: 0 });
  // Optional, no default: blank means "not set", not zero.
  const maxCpcWaste = str(config, "maxCPCWasteThreshold") ? num(config, "maxCPCWasteThreshold", 0, { min: 0 }) : null;
  const targetRoasPct = str(config, "targetROAS") ? num(config, "targetROAS", 0, { min: 0 }) : null;
  const campaignFilter = str(config, "campaignFilter", "All Campaigns");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  // --- Live Google Ads Data ---
  let liveAdsData: string | null = null;
  let source = "simulation";

  const adsIntegration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "GOOGLE_ADS",
      },
    },
  });

  // Not connected → simulating below is fine. Connected but the call fails →
  // fail the run rather than quietly ship simulated numbers as "live".
  if (adsIntegration) {
    try {
      const creds = await googleCredentials(adsIntegration);
      // A submitted dropdown choice wins over the integration's saved
      // default — but it's still just a client string, so it's checked
      // against what this grant can actually reach first.
      // The resolved value carries the manager (MCC) the account is reached
      // through, when there is one — it becomes login-customer-id.
      const selection = parseGoogleAdsAccountValue(await resolvePropertyOverride("GOOGLE_ADS", creds, accountId));
      if (!selection) {
        throw new AgentInputError(
          "Google Ads is connected, but no account has been selected.",
          "Open Integrations → Google Ads and choose an account.",
          "integration_not_configured",
        );
      }

      const chunks = await googleAdsSearchStream<AdsStreamChunk>(
        creds.access_token,
        selection,
        [
          "SELECT campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE",
          gaqlDateClause(auditWindowDays),
          CHANNEL_TYPE_FILTER[campaignFilter]
            ? `AND campaign.advertising_channel_type = '${CHANNEL_TYPE_FILTER[campaignFilter]}'`
            : "",
        ].filter(Boolean).join(" "),
      );

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

      // Low-sample campaigns are left out of the evaluation, not silently averaged in.
      const evaluated = campaigns.filter((c) => c.impressions >= minImpressions);
      const excluded = campaigns.length - evaluated.length;
      liveAdsData =
        JSON.stringify(evaluated, null, 2) +
        (excluded > 0 ? `\n(${excluded} campaign(s) under ${minImpressions} impressions excluded as too low-sample to evaluate.)` : "");
      source = "live";
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Ads", err instanceof Error ? err.message : String(err));
    }
  }

  const systemPrompt = `You are an expert Google Ads copywriter and search marketing strategist. You write RSA (Responsive Search Ad) headlines and descriptions that maximize Quality Score and CTR. You analyze search terms to identify high-value keywords and irrelevant negatives. You understand match types, intent signals, conversion-focused messaging, and spend anomaly detection.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const liveDataBlock = liveAdsData
    ? `\n\nLive Google Ads Campaign Performance (Last ${auditWindowDays} Days${CHANNEL_TYPE_FILTER[campaignFilter] ? `, ${campaignFilter}` : ""}):\n${liveAdsData}\n\nUse the above real campaign data to ground your RSA recommendations, keyword priorities, and bid strategy rationale. Reference actual campaign names and performance figures in your analysis.`
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
- Campaign Types in Scope: ${campaignFilter}
- Audit Window: last ${auditWindowDays} days
- Primary Conversion Action: ${primaryConversionAction || "Not specified"} — judge performance, CPA and bid strategy against this conversion, not all conversions
${maxCpcWaste !== null ? `- Budget Waste Threshold: flag any search term or keyword spending above $${maxCpcWaste} CPC with zero conversions in wastedSpendRisks and spendAnomalyAlerts\n` : ""}${targetRoasPct !== null ? `- Target ROAS: ${targetRoasPct}% (${(targetRoasPct / 100).toFixed(1)}x) — bidStrategy.targetROAS and its rationale must align to this\n` : ""}${negativesReview ? "" : "- Negative keyword recommendations were NOT requested: return empty arrays for negativeKeywords.campaign and negativeKeywords.adGroup.\n"}${liveDataBlock}

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
  output.source = source;

  if (source === "simulation") {
    output.simulationNote =
      "Connect Google Ads API in Settings to enable live search term data, real Quality Scores, spend anomaly monitoring, and automated negative keyword management";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};
