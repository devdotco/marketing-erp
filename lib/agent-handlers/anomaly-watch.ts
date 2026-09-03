import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const anomalyWatchHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const ga4Property = String(config.ga4Property ?? "");
  const trackedMetrics = String(config.trackedMetrics ?? "All");
  const sensitivityLevel = String(config.sensitivityLevel ?? "Medium");
  const correlateDeployDates = config.correlateDeployDates !== false;
  const alertRecipients = String(config.alertRecipients ?? "");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const sigmaThreshold =
    sensitivityLevel === "High" ? 1.5 : sensitivityLevel === "Low" ? 3.0 : 2.0;

  const metricsScope =
    trackedMetrics === "Traffic only"
      ? "sessions, users, pageviews, bounce rate, engagement rate"
      : trackedMetrics === "Conversions only"
        ? "goal completions, conversion rate, form submissions"
        : trackedMetrics === "Revenue only"
          ? "revenue, transactions, average order value, ROAS"
          : "sessions, users, pageviews, bounce rate, engagement rate, goal completions, conversion rate, revenue";

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
        businessProfile.goals
          ? `Primary goals: ${JSON.stringify(businessProfile.goals)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const systemPrompt = `You are a marketing analytics anomaly detection specialist.
Only flag genuine statistical anomalies (>${sigmaThreshold} sigma from baseline). Never alert on normal daily variance.
Always correlate anomalies with known events (deploys, campaigns, seasonality) before escalating.
Distinguish between true anomalies and expected patterns (weekend dips, post-launch surges, seasonal cycles).
Return ONLY valid JSON — no markdown fences, no preamble.`;

  const today = new Date();
  const reportDate = today.toISOString().split("T")[0];

  const userPrompt = `Perform anomaly detection analysis for GA4 property: ${ga4Property}

Business context:
${businessContext || "No business profile configured."}

Analysis parameters:
- Tracked metrics: ${metricsScope}
- Sensitivity level: ${sensitivityLevel} (flag deviations >${sigmaThreshold} sigma)
- Correlate with deploy dates: ${correlateDeployDates}
- Alert recipients: ${alertRecipients || "None configured"}
- Report date: ${reportDate}

Simulate a realistic anomaly detection run for this property. Generate anomalies that would actually warrant attention for a ${businessProfile?.industry ?? "general"} business — not every metric will have anomalies.

Return this exact JSON structure:
${JSON.stringify({
  reportDate,
  ga4Property,
  period: "Last 7 days vs prior 28-day baseline",
  baselineLearningDays: 28,
  anomalies: [
    {
      metric: "Organic Sessions",
      currentValue: 0,
      baselineValue: 0,
      deviationPct: 0,
      deviationSigma: 0,
      direction: "spike" as const,
      severity: "warning" as const,
      possibleCauses: ["string"],
      correlatedEvents: ["string"],
      recommendedAction: "string",
    },
  ],
  allClear: [
    {
      metric: "string",
      currentValue: 0,
      baselineValue: 0,
      status: "normal" as const,
    },
  ],
  alertsSent: [] as string[],
  simulationNote:
    "Connect GA4 in Settings to monitor real metric baselines. This report simulates anomaly detection based on your property configuration.",
})}

Make anomaly values realistic for a ${businessProfile?.industry ?? "general"} business. Include 1-3 genuine anomalies and 4-6 all-clear metrics. Populate correlatedEvents with realistic possibilities (e.g., "Weekend traffic pattern", "Recent blog publish", "Seasonal variation").`;

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
