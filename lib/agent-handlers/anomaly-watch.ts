import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

interface Ga4Row {
  dimensionValues: Array<{ value: string }>;
  metricValues: Array<{ value: string }>;
}

interface Ga4Response {
  rows?: Ga4Row[];
}

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

  // --- Live GA4 Daily Sessions (90-day window) ---
  let liveAnomalyBlock: string | null = null;
  let precomputedAnomalies: string | null = null;
  let source = "simulation";

  try {
    const ga4Integration = await prisma.integration.findUnique({
      where: {
        workspaceId_provider: {
          workspaceId: run.agentConfig.workspaceId,
          provider: "GOOGLE_ANALYTICS_4",
        },
      },
    });

    if (ga4Integration?.encryptedCredentials) {
      const creds = await decryptCredentials<{
        access_token: string;
        property_id: string;
      }>(ga4Integration.encryptedCredentials);

      const ga4Res = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${creds.property_id}:runReport`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dateRanges: [{ startDate: "90daysAgo", endDate: "today" }],
            dimensions: [{ name: "date" }],
            metrics: [{ name: "sessions" }],
            orderBys: [{ dimension: { dimensionName: "date" } }],
          }),
        }
      );

      if (ga4Res.ok) {
        const ga4Data = (await ga4Res.json()) as Ga4Response;
        const dailyRows = (ga4Data.rows ?? []).map((row) => ({
          date: row.dimensionValues[0]?.value ?? "",
          sessions: Number(row.metricValues[0]?.value ?? 0),
        }));

        if (dailyRows.length >= 8) {
          // Baseline = all days except the most recent 7
          const baselineDays = dailyRows.slice(0, dailyRows.length - 7);
          const recentDays = dailyRows.slice(-7);

          const baselineSum = baselineDays.reduce((s, d) => s + d.sessions, 0);
          const baselineAvg = baselineDays.length > 0 ? baselineSum / baselineDays.length : 0;

          const recentSum = recentDays.reduce((s, d) => s + d.sessions, 0);
          const recentAvg = recentDays.length > 0 ? recentSum / recentDays.length : 0;

          const deviationPct =
            baselineAvg > 0
              ? Math.round(((recentAvg - baselineAvg) / baselineAvg) * 1000) / 10
              : 0;

          // Standard deviation of baseline for sigma calculation
          const variance =
            baselineDays.length > 1
              ? baselineDays.reduce((s, d) => s + Math.pow(d.sessions - baselineAvg, 2), 0) /
                (baselineDays.length - 1)
              : 0;
          const stdDev = Math.sqrt(variance);
          const deviationSigma =
            stdDev > 0
              ? Math.round(Math.abs(recentAvg - baselineAvg) / stdDev * 10) / 10
              : 0;

          const isAnomaly = Math.abs(deviationPct) > 20 || deviationSigma > sigmaThreshold;

          liveAnomalyBlock = `Live GA4 Daily Sessions (last 90 days, property: ${creds.property_id}):\n${JSON.stringify(dailyRows, null, 2)}`;

          precomputedAnomalies = JSON.stringify({
            metric: "Daily Sessions",
            baselineAvgDaily: Math.round(baselineAvg),
            recentAvgDaily: Math.round(recentAvg),
            deviationPct,
            deviationSigma,
            direction: recentAvg >= baselineAvg ? "spike" : "drop",
            isAnomaly,
            recentDays,
            baselineDays: baselineDays.length,
          }, null, 2);

          source = "live";
        }
      }
    }
  } catch {
    // fall through to simulation
  }

  const liveDataSection = liveAnomalyBlock
    ? `\n\nLIVE GA4 DATA — use the pre-computed baseline analysis below to populate the anomalies and allClear arrays with accurate values. Do not invent data — use these real figures:\n\nPre-computed anomaly analysis:\n${precomputedAnomalies ?? ""}\n\nFull daily sessions history (for additional context):\n${liveAnomalyBlock}`
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
${liveDataSection}

${source === "live" ? "Use the real GA4 data above to populate anomalies with accurate baselines, deviations, and directions." : `Simulate a realistic anomaly detection run for this property. Generate anomalies that would actually warrant attention for a ${businessProfile?.industry ?? "general"} business — not every metric will have anomalies.`}

Return this exact JSON structure:
${JSON.stringify({
  reportDate,
  ga4Property,
  period: "Last 7 days vs prior 83-day baseline",
  baselineLearningDays: 83,
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

${source === "live" ? "Base the sessions anomaly entry on the pre-computed values provided. For allClear metrics, extrapolate reasonable values from the session data. Set alertsSent to an empty array unless alertRecipients are configured." : `Make anomaly values realistic for a ${businessProfile?.industry ?? "general"} business. Include 1-3 genuine anomalies and 4-6 all-clear metrics. Populate correlatedEvents with realistic possibilities (e.g., "Weekend traffic pattern", "Recent blog publish", "Seasonal variation").`}`;

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
  output.source = source;

  if (source === "simulation") {
    output.simulationNote =
      "Connect GA4 in Settings to monitor real metric baselines. This report simulates anomaly detection based on your property configuration.";
  }

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
