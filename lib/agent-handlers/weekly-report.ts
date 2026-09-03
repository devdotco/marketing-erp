import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const weeklyReportHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const ga4Property = (config.ga4Property as string) ?? "";
  const gscProperty = (config.gscProperty as string) ?? "";
  const adsAccount = (config.adsAccount as string) ?? "";
  const reportPeriod = (config.reportPeriod as string) ?? "Last 7 days";
  const clientName = (config.clientName as string) ?? "Client";
  const whiteLabelBrand = (config.whiteLabelBrand as string) ?? "Marketing Analytics";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

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
- Prepared by: ${whiteLabelBrand}
- Prepared for: ${clientName}

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
    "Connect GA4, Google Search Console, and Google Ads in Settings to enable live data. Current output is AI-generated using your business profile and industry benchmarks as context.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};
