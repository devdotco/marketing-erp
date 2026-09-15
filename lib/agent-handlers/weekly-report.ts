import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { GOOGLE_ADS_API_VERSION, googleAdsHeaders, googleCredentials, liveCallFailed } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { num, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

interface Ga4Row {
  dimensionValues: Array<{ value: string }>;
  metricValues: Array<{ value: string }>;
}

interface Ga4Response {
  rows?: Ga4Row[];
}

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

export const weeklyReportHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);

  const ga4Property = (config.ga4Property as string) ?? "";
  const gscProperty = (config.gscProperty as string) ?? "";
  const adsAccount = (config.adsAccount as string) ?? "";
  const windowDays = num(config, "reportingWindowDays", 7, { min: 1, max: 90 });
  const comparisonPeriod = str(config, "comparisonPeriod", "Previous period");
  const includedMetrics = str(config, "includedMetrics", "Traffic + Conversions + Spend");
  const includeSpend = includedMetrics !== "Traffic + Conversions only";
  const clientName = str(config, "brandName", "Client");
  const whiteLabelBrand = str(config, "whiteLabelBrand", "Marketing Analytics");

  // The reporting window ends yesterday (today is still incomplete); the
  // comparison windows are the same length, shifted back.
  const fmtDate = (d: Date) => d.toISOString().split("T")[0];
  const shift = (d: Date, days: number) => {
    const next = new Date(d);
    next.setDate(next.getDate() + days);
    return next;
  };
  const shiftYear = (d: Date) => {
    const next = new Date(d);
    next.setFullYear(next.getFullYear() - 1);
    return next;
  };
  const periodEnd = shift(new Date(), -1);
  const periodStart = shift(periodEnd, -(windowDays - 1));
  const reportPeriod = `${fmtDate(periodStart)} to ${fmtDate(periodEnd)} (last ${windowDays} days)`;
  const ga4DateRanges: Array<{ name: string; startDate: string; endDate: string }> = [
    { name: "current", startDate: fmtDate(periodStart), endDate: fmtDate(periodEnd) },
  ];
  if (comparisonPeriod === "Previous period" || comparisonPeriod === "Both") {
    ga4DateRanges.push({ name: "previous_period", startDate: fmtDate(shift(periodStart, -windowDays)), endDate: fmtDate(shift(periodStart, -1)) });
  }
  if (comparisonPeriod === "Same period last year" || comparisonPeriod === "Both") {
    ga4DateRanges.push({ name: "same_period_last_year", startDate: fmtDate(shiftYear(periodStart)), endDate: fmtDate(shiftYear(periodEnd)) });
  }

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  // --- Live GA4 Data ---
  let liveGa4Block: string | null = null;
  let liveAdsBlock: string | null = null;
  let source = "simulation";

  const ga4Integration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "GOOGLE_ANALYTICS_4",
      },
    },
  });

  // Not connected → simulating below is fine. Connected but the call fails →
  // fail the run rather than quietly ship simulated numbers as "live".
  if (ga4Integration) {
    try {
      const ga4Creds = await googleCredentials(ga4Integration);
      // A submitted dropdown choice wins over the integration's saved
      // default — but it's still just a client string, so it's checked
      // against what this grant can actually reach first.
      const ga4PropertyId = await resolvePropertyOverride("GOOGLE_ANALYTICS_4", ga4Creds, ga4Property);
      if (!ga4PropertyId) {
        throw new AgentInputError(
          "Google Analytics 4 is connected, but no property has been selected.",
          "Open Integrations → Google Analytics 4 and choose a property.",
          "integration_not_configured",
        );
      }

      const ga4Res = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${ga4PropertyId}:runReport`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ga4Creds.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dateRanges: ga4DateRanges,
            dimensions: [{ name: "sessionDefaultChannelGroup" }],
            metrics: [{ name: "sessions" }, { name: "conversions" }],
          }),
        }
      );
      if (!ga4Res.ok) {
        throw new Error(`GA4 Data API ${ga4Res.status}: ${(await ga4Res.text()).slice(0, 300)}`);
      }

      const ga4Data = (await ga4Res.json()) as Ga4Response;
      // With more than one date range GA4 appends the range name as a trailing dimension.
      const channelRows = (ga4Data.rows ?? []).map((row) => ({
        channel: row.dimensionValues[0]?.value ?? "Unknown",
        period: ga4DateRanges.length > 1 ? (row.dimensionValues[1]?.value ?? "current") : "current",
        sessions: Number(row.metricValues[0]?.value ?? 0),
        conversions: Number(row.metricValues[1]?.value ?? 0),
      }));
      liveGa4Block = `Live GA4 Channel Performance (${ga4DateRanges.map((r) => `${r.name}: ${r.startDate} to ${r.endDate}`).join("; ")}):\n${JSON.stringify(channelRows, null, 2)}`;
      source = "live";
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Analytics 4", err instanceof Error ? err.message : String(err));
    }
  }

  const adsIntegration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "GOOGLE_ADS",
      },
    },
  });

  // Spend left out of the report → the Ads account isn't queried at all.
  if (adsIntegration && includeSpend) {
    try {
      const adsCreds = await googleCredentials(adsIntegration);
      // A submitted dropdown choice wins over the integration's saved
      // default — but it's still just a client string, so it's checked
      // against what this grant can actually reach first.
      const adsCustomerId = await resolvePropertyOverride("GOOGLE_ADS", adsCreds, adsAccount.replace(/-/g, ""));
      if (!adsCustomerId) {
        throw new AgentInputError(
          "Google Ads is connected, but no account has been selected.",
          "Open Integrations → Google Ads and choose an account.",
          "integration_not_configured",
        );
      }

      const adsRes = await fetch(
        `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${adsCustomerId}/googleAds:searchStream`,
        {
          method: "POST",
          headers: googleAdsHeaders(adsCreds.access_token),
          body: JSON.stringify({
            query:
              `SELECT campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${fmtDate(periodStart)}' AND '${fmtDate(periodEnd)}'`,
          }),
        }
      );
      if (!adsRes.ok) {
        throw new Error(`Google Ads API ${adsRes.status}: ${(await adsRes.text()).slice(0, 300)}`);
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

      liveAdsBlock = `Live Google Ads Campaign Performance (${reportPeriod}):\n${JSON.stringify(campaigns, null, 2)}`;
      source = "live";
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Ads", err instanceof Error ? err.message : String(err));
    }
  }

  const liveDataSection =
    liveGa4Block || liveAdsBlock
      ? `\n\nLIVE DATA — use these real figures when populating keyMetrics, significantMovements, paidCampaignSummary, and keywordMovers:\n${[liveGa4Block, liveAdsBlock].filter(Boolean).join("\n\n")}`
      : "";

  const systemPrompt = `You are a senior digital marketing analyst creating a client-ready weekly performance report for ${whiteLabelBrand}.
You synthesize data from Google Analytics 4, Google Search Console, and Google Ads to produce narrative prose reports highlighting 3 significant movements.
Your reports are professional, insightful, and actionable. You always explain the "why" behind data movements and provide strategic recommendations.
Always respond with a single valid JSON object — no markdown, no prose outside the JSON.`;

  const userPrompt = `Generate a comprehensive weekly marketing performance report for ${clientName}.

Business Context:
- Business: ${businessProfile?.businessName ?? clientName}
- Industry: ${businessProfile?.industry ?? "General"}
- Website: ${businessProfile?.websiteUrl ?? "N/A"}
- Description: ${businessProfile?.uniqueValueProp ?? "N/A"}

Report Configuration:
- GA4 Property: ${ga4Property}
- GSC Property: ${gscProperty}
- Google Ads Account: ${adsAccount}
- Report Period: ${reportPeriod}
- Comparison Period for every delta: ${comparisonPeriod}${comparisonPeriod === "Both" ? " (report deltas against the previous period, and add the year-over-year change in each narrative)" : ""}
- Metric Groups: ${includedMetrics}${includeSpend ? "" : " — paid media is excluded: set keyMetrics.paid to null and paidCampaignSummary to []"}
- Prepared by: ${whiteLabelBrand}
- Prepared for: ${clientName}
${liveDataSection}

Respond with a JSON object matching this exact structure:
{
  "reportTitle": "Weekly Performance Report — [Period Dates]",
  "reportPeriod": "${reportPeriod}",
  "preparedBy": "${whiteLabelBrand}",
  "preparedFor": "${clientName}",
  "executiveSummary": "2-3 sentence narrative overview of the period — what happened, what drove it, and what it means for the business",
  "performancePulse": {
    "overallHealthScore": 0-100,
    "trend": "improving|stable|declining",
    "headline": "One punchy sentence capturing the week"
  },
  "keyMetrics": {
    "organic": {
      "sessions": number,
      "sessionsDelta": "+X.X%",
      "sessions7DayChart": [{"day":"Mon","value":number},{"day":"Tue","value":number},{"day":"Wed","value":number},{"day":"Thu","value":number},{"day":"Fri","value":number},{"day":"Sat","value":number},{"day":"Sun","value":number}],
      "users": number,
      "usersDelta": "+X.X%",
      "avgEngagementTimeSec": number,
      "engagementRate": "X.X%",
      "bounceRate": "X.X%"
    },
    "paid": {
      "impressions": number,
      "clicks": number,
      "ctr": "X.XX%",
      "cpc": "$X.XX",
      "spend": "$X,XXX.XX",
      "conversions": number,
      "cpa": "$XXX.XX",
      "roas": "X.Xx",
      "roasDelta": "+X.X%"
    },
    "search": {
      "totalClicks": number,
      "totalImpressions": number,
      "avgPosition": number,
      "ctr": "X.X%",
      "indexedPages": number,
      "topKeyword": "exact keyword phrase",
      "topKeywordClicks": number
    },
    "conversions": {
      "totalGoalCompletions": number,
      "goalCompletionsDelta": "+X.X%",
      "conversionRate": "X.X%",
      "topConversionPath": "Organic Search > Landing Page > Contact"
    }
  },
  "significantMovements": [
    {
      "rank": 1,
      "title": "Movement Title",
      "category": "organic|paid|search|conversion|technical",
      "direction": "up|down",
      "magnitude": "+XX%",
      "narrative": "3-4 sentence explanation of what happened, why it matters for ${clientName}, what likely drove it, and what it signals going forward",
      "chartData": [
        {"label":"Mon","currentValue":number,"priorValue":number},
        {"label":"Tue","currentValue":number,"priorValue":number},
        {"label":"Wed","currentValue":number,"priorValue":number},
        {"label":"Thu","currentValue":number,"priorValue":number},
        {"label":"Fri","currentValue":number,"priorValue":number},
        {"label":"Sat","currentValue":number,"priorValue":number},
        {"label":"Sun","currentValue":number,"priorValue":number}
      ],
      "metricAffected": "Exact metric name",
      "recommendation": "Specific, actionable next step with timeline"
    },
    {
      "rank": 2,
      "title": "Movement Title",
      "category": "organic|paid|search|conversion|technical",
      "direction": "up|down",
      "magnitude": "+XX%",
      "narrative": "3-4 sentence explanation",
      "chartData": [
        {"label":"Mon","currentValue":number,"priorValue":number},
        {"label":"Tue","currentValue":number,"priorValue":number},
        {"label":"Wed","currentValue":number,"priorValue":number},
        {"label":"Thu","currentValue":number,"priorValue":number},
        {"label":"Fri","currentValue":number,"priorValue":number},
        {"label":"Sat","currentValue":number,"priorValue":number},
        {"label":"Sun","currentValue":number,"priorValue":number}
      ],
      "metricAffected": "Exact metric name",
      "recommendation": "Specific, actionable next step with timeline"
    },
    {
      "rank": 3,
      "title": "Movement Title",
      "category": "organic|paid|search|conversion|technical",
      "direction": "up|down",
      "magnitude": "+XX%",
      "narrative": "3-4 sentence explanation",
      "chartData": [
        {"label":"Mon","currentValue":number,"priorValue":number},
        {"label":"Tue","currentValue":number,"priorValue":number},
        {"label":"Wed","currentValue":number,"priorValue":number},
        {"label":"Thu","currentValue":number,"priorValue":number},
        {"label":"Fri","currentValue":number,"priorValue":number},
        {"label":"Sat","currentValue":number,"priorValue":number},
        {"label":"Sun","currentValue":number,"priorValue":number}
      ],
      "metricAffected": "Exact metric name",
      "recommendation": "Specific, actionable next step with timeline"
    }
  ],
  "topPerformingContent": [
    {
      "rank": 1,
      "url": "/page-path",
      "pageTitle": "Page Title",
      "sessions": number,
      "sessionsDelta": "+X%",
      "avgEngagementTimeSec": number,
      "conversions": number,
      "insight": "One sentence on why this page performed and what to learn from it"
    },
    {
      "rank": 2,
      "url": "/page-path",
      "pageTitle": "Page Title",
      "sessions": number,
      "sessionsDelta": "+X%",
      "avgEngagementTimeSec": number,
      "conversions": number,
      "insight": "One sentence insight"
    },
    {
      "rank": 3,
      "url": "/page-path",
      "pageTitle": "Page Title",
      "sessions": number,
      "sessionsDelta": "+X%",
      "avgEngagementTimeSec": number,
      "conversions": number,
      "insight": "One sentence insight"
    },
    {
      "rank": 4,
      "url": "/page-path",
      "pageTitle": "Page Title",
      "sessions": number,
      "sessionsDelta": "-X%",
      "avgEngagementTimeSec": number,
      "conversions": number,
      "insight": "One sentence insight"
    },
    {
      "rank": 5,
      "url": "/page-path",
      "pageTitle": "Page Title",
      "sessions": number,
      "sessionsDelta": "+X%",
      "avgEngagementTimeSec": number,
      "conversions": number,
      "insight": "One sentence insight"
    }
  ],
  "keywordMovers": {
    "risers": [
      {
        "keyword": "exact keyword phrase",
        "currentPosition": number,
        "previousPosition": number,
        "positionChange": number,
        "weeklyImpressions": number,
        "weeklyClicks": number,
        "ctr": "X.X%",
        "opportunity": "What this ranking improvement unlocks"
      }
    ],
    "fallers": [
      {
        "keyword": "exact keyword phrase",
        "currentPosition": number,
        "previousPosition": number,
        "positionChange": number,
        "weeklyImpressions": number,
        "weeklyClicks": number,
        "ctr": "X.X%",
        "riskNote": "Why this matters and what to watch"
      }
    ],
    "newEntries": [
      {
        "keyword": "exact keyword phrase",
        "currentPosition": number,
        "weeklyImpressions": number,
        "weeklyClicks": number,
        "potential": "high|medium|low"
      }
    ]
  },
  "paidCampaignSummary": [
    {
      "campaignName": "Campaign Name",
      "type": "Search|Display|Shopping|Performance Max|Video",
      "spend": "$X,XXX.XX",
      "impressions": number,
      "clicks": number,
      "ctr": "X.XX%",
      "cpc": "$X.XX",
      "conversions": number,
      "cpa": "$XXX.XX",
      "roas": "X.Xx",
      "status": "strong|on-target|underperforming|paused",
      "statusNote": "One sentence on this campaign's performance this week"
    }
  ],
  "anomalyAlerts": [
    {
      "severity": "high|medium|low",
      "metric": "Metric Name",
      "description": "What happened and when",
      "possibleCause": "Most likely explanation",
      "actionRequired": boolean
    }
  ],
  "strategicRecommendations": [
    {
      "priority": "high|medium|low",
      "area": "SEO|Paid Search|Content|Technical|CRO|Analytics",
      "recommendation": "Specific, actionable recommendation",
      "rationale": "Why this matters right now",
      "expectedImpact": "Measurable outcome if implemented",
      "effort": "low|medium|high",
      "timeline": "This week|Next 2 weeks|This month"
    }
  ],
  "nextWeekFocus": "A narrative paragraph (3-5 sentences) on what ${clientName} and the team should prioritize in the coming week, referencing specific findings from this report"
}

Make all numbers realistic for a ${businessProfile?.industry ?? "general"} business. The 3 significant movements must each have compelling, specific narratives — not generic filler. Chart data arrays must have exactly 7 entries. Campaign and keyword data should be realistic for the business scale.`;

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
      "Connect GA4, Google Search Console, and Google Ads in Settings to enable live data. Current output is AI-generated using your business profile and industry benchmarks as context.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};
