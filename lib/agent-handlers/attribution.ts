import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const attributionHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const ga4Property = String(config.ga4Property ?? "");
  const crmIntegration = String(config.crmIntegration ?? "Manual");
  const attributionWindow = String(config.attributionWindow ?? "30 days");
  const revenueMetric = String(config.revenueMetric ?? "");
  const darkSocialEstimate = config.darkSocialEstimate !== false;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const businessContext = businessProfile
    ? [
        businessProfile.businessName
          ? `Business: ${businessProfile.businessName}`
          : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.websiteUrl
          ? `Website: ${businessProfile.websiteUrl}`
          : "",
        businessProfile.targetAudience
          ? `Target audience: ${businessProfile.targetAudience}`
          : "",
        businessProfile.uniqueValueProp
          ? `UVP: ${businessProfile.uniqueValueProp}`
          : "",
        businessProfile.goals
          ? `Goals: ${JSON.stringify(businessProfile.goals)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const today = new Date();
  const windowDays = parseInt(attributionWindow.split(" ")[0], 10) || 30;
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - windowDays);
  const reportPeriod = `${startDate.toISOString().split("T")[0]} to ${today.toISOString().split("T")[0]}`;

  const systemPrompt = `You are a marketing attribution analyst.
Present all three attribution models simultaneously — no single model is correct.
Help the client understand the trade-offs between first-touch, last-touch, and linear/assisted attribution.
Dark social (direct/dark traffic, Slack shares, private messages) is often 20-40% of B2B conversions and systematically under-reported.
Be specific about channel names and percentages. Return ONLY valid JSON — no markdown fences, no preamble.`;

  const userPrompt = `Generate a multi-touch attribution analysis for:
- GA4 Property: ${ga4Property}
- CRM Integration: ${crmIntegration}
- Attribution Window: ${attributionWindow}
- Revenue Metric: ${revenueMetric || "Not specified"}
- Report Period: ${reportPeriod}
- Include Dark Social Estimate: ${darkSocialEstimate}

Business context:
${businessContext || "No business profile configured."}

Generate realistic attribution data appropriate for a ${businessProfile?.industry ?? "general"} business. Include channels typical for this industry (Organic Search, Paid Search, Direct, Email, Social, Referral, etc.).

Return this exact JSON structure:
${JSON.stringify({
  reportPeriod,
  totalRevenue: null as number | null,
  models: {
    firstTouch: [
      {
        channel: "Organic Search",
        sessions: 0,
        conversions: 0,
        revenue: null as number | null,
        pct: 0,
      },
    ],
    lastTouch: [
      {
        channel: "Organic Search",
        sessions: 0,
        conversions: 0,
        revenue: null as number | null,
        pct: 0,
      },
    ],
    linearAssisted: [
      {
        channel: "Organic Search",
        touchpoints: 0,
        assisted_conversions: 0,
        revenue: null as number | null,
        pct: 0,
      },
    ],
  },
  blindSpots: [
    {
      channel: "string",
      description: "string",
      estimatedImpact: "string",
      howToMeasure: "string",
    },
  ],
  darkSocialEstimate: {
    estimatedUnattributedPct: 0,
    likelySources: ["string"],
    measurementSuggestions: ["string"],
  },
  insights: ["string"],
  simulationNote:
    "Connect GA4 and your CRM in Settings to pull real conversion and revenue data. This report uses estimated attribution based on your channel mix.",
})}

Generate 5-7 channels per model with realistic percentage distributions that sum to 100%. Include 2-3 blind spots and 3-5 strategic insights. ${darkSocialEstimate ? "Include a meaningful dark social estimate (20-40% for B2B, 10-20% for B2C)." : ""}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText =
    message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  // Haiku 4.5 pricing: $0.80/M input, $4/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
