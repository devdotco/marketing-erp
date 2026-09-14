import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { GOOGLE_ADS_API_VERSION, googleAdsHeaders, googleCredentials, liveCallFailed } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

interface Ga4Row {
  dimensionValues: Array<{ value: string }>;
  metricValues: Array<{ value: string }>;
}

interface Ga4Response {
  rows?: Ga4Row[];
}

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
}
interface GscResponse {
  rows?: GscRow[];
}

interface AdsStreamChunk {
  results?: Array<{
    segments: { date: string };
    metrics: { costMicros: string; clicks: string; impressions: string };
  }>;
}

type DailyPoint = { date: string; value: number };

/** Deviation of the last 7 days' average against the baseline average, in both % and sigma. */
function deviate(baseline: DailyPoint[], recent: DailyPoint[]) {
  const baselineAvg = baseline.length > 0 ? baseline.reduce((s, d) => s + d.value, 0) / baseline.length : 0;
  const recentAvg = recent.length > 0 ? recent.reduce((s, d) => s + d.value, 0) / recent.length : 0;
  const deviationPct = baselineAvg > 0 ? Math.round(((recentAvg - baselineAvg) / baselineAvg) * 1000) / 10 : 0;
  const variance =
    baseline.length > 1
      ? baseline.reduce((s, d) => s + Math.pow(d.value - baselineAvg, 2), 0) / (baseline.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const deviationSigma = stdDev > 0 ? Math.round((Math.abs(recentAvg - baselineAvg) / stdDev) * 10) / 10 : 0;
  return { baselineAvg, recentAvg, deviationPct, deviationSigma, direction: recentAvg >= baselineAvg ? "spike" as const : "drop" as const };
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export const anomalyWatchHandler: AgentHandler = async (run, updateStatus) => {
  const config = resolveInputs(run);

  const ga4PropertyOverride = String(config.ga4PropertyId ?? "");
  const gscSiteOverride = String(config.gscSiteUrl ?? "");
  const adsCustomerOverride = String(config.googleAdsCustomerId ?? "");
  const trackedMetrics = String(config.trackedMetrics ?? "All");
  const sensitivityLevel = String(config.sensitivityLevel ?? "Medium");
  const correlateDeployDates = config.correlateDeployDates !== false;
  const alertRecipients = String(config.alertRecipients ?? "");
  const minimumSessionThreshold = Number(config.minimumSessionThreshold ?? 100);
  const pauseOnWeekends = config.pauseOnWeekends === true;

  // Skip entirely on weekends when configured to — no API calls, no Anthropic
  // spend, just a note that the check didn't run today.
  const todayDow = new Date().getUTCDay();
  if (pauseOnWeekends && (todayDow === 0 || todayDow === 6)) {
    await updateStatus("RUNNING");
    const output: Record<string, unknown> = {
      reportDate: formatDate(new Date()),
      skipped: true,
      skipReason: "Paused for the weekend (Pause Checks on Weekends is enabled).",
      generatedAt: new Date().toISOString(),
      workspaceId: run.agentConfig.workspaceId,
      source: "skipped",
    };
    const requireApproval = config.requireApproval !== false;
    if (requireApproval) await updateStatus("AWAITING_APPROVAL", output);
    return { output, costUsd: 0 };
  }

  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const sigmaThreshold =
    sensitivityLevel === "High" ? 1.5 : sensitivityLevel === "Low" ? 3.0 : 2.0;

  const wantsTraffic = trackedMetrics === "All" || trackedMetrics === "Traffic only";
  const wantsConversions = trackedMetrics === "All" || trackedMetrics === "Conversions only";
  const wantsRevenue = trackedMetrics === "All" || trackedMetrics === "Revenue only";

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
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.goals ? `Primary goals: ${JSON.stringify(businessProfile.goals)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const liveBlocks: string[] = [];
  const precomputed: Record<string, unknown> = {};
  let ga4Live = false;
  let gscLive = false;
  let adsLive = false;
  let ga4PropertyResolved = ga4PropertyOverride;
  let gscPropertyResolved = gscSiteOverride;
  let adsCustomerResolved = adsCustomerOverride;
  let skippedForLowTraffic = false;

  // --- GA4: sessions (always), conversions / revenue (per trackedMetrics) ---
  const ga4Integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "GOOGLE_ANALYTICS_4" } },
  });

  // Not connected → simulating below is fine. Connected but the call fails →
  // this must fail the run, not quietly ship simulated numbers as "live".
  if (ga4Integration) {
    try {
      const creds = await googleCredentials(ga4Integration);
      // A submitted dropdown choice wins over the integration's saved
      // default — but it's still just a client string, so it's checked
      // against what this grant can actually reach first.
      const propertyId = await resolvePropertyOverride("GOOGLE_ANALYTICS_4", creds, ga4PropertyOverride);
      if (!propertyId) {
        throw new AgentInputError(
          "Google Analytics 4 is connected, but no property has been selected.",
          "Open Integrations → Google Analytics 4 and choose a property, or set a GA4 Property ID override on this agent.",
          "integration_not_configured",
        );
      }
      ga4PropertyResolved = propertyId;

      const metrics = [
        { name: "sessions" },
        ...(wantsConversions ? [{ name: "conversions" }] : []),
        ...(wantsRevenue ? [{ name: "totalRevenue" }] : []),
      ];

      const ga4Res = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${creds.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            dateRanges: [{ startDate: "90daysAgo", endDate: "today" }],
            dimensions: [{ name: "date" }],
            metrics,
            orderBys: [{ dimension: { dimensionName: "date" } }],
          }),
        }
      );
      if (!ga4Res.ok) {
        throw new Error(`GA4 Data API ${ga4Res.status}: ${(await ga4Res.text()).slice(0, 300)}`);
      }

      const ga4Data = (await ga4Res.json()) as Ga4Response;
      const dailyRows = (ga4Data.rows ?? []).map((row) => ({
        date: row.dimensionValues[0]?.value ?? "",
        sessions: Number(row.metricValues[0]?.value ?? 0),
        conversions: wantsConversions ? Number(row.metricValues[1]?.value ?? 0) : undefined,
        revenue: wantsRevenue ? Number(row.metricValues[wantsConversions ? 2 : 1]?.value ?? 0) : undefined,
      }));

      if (dailyRows.length >= 8) {
        const baselineDays = dailyRows.slice(0, dailyRows.length - 7);
        const recentDays = dailyRows.slice(-7);
        const baselineAvgSessions =
          baselineDays.length > 0 ? baselineDays.reduce((s, d) => s + d.sessions, 0) / baselineDays.length : 0;

        if (baselineAvgSessions < minimumSessionThreshold) {
          skippedForLowTraffic = true;
        } else {
          const sessionsDev = deviate(
            baselineDays.map((d) => ({ date: d.date, value: d.sessions })),
            recentDays.map((d) => ({ date: d.date, value: d.sessions })),
          );
          precomputed.sessions = {
            metric: "Daily Sessions",
            baselineAvgDaily: Math.round(sessionsDev.baselineAvg),
            recentAvgDaily: Math.round(sessionsDev.recentAvg),
            deviationPct: sessionsDev.deviationPct,
            deviationSigma: sessionsDev.deviationSigma,
            direction: sessionsDev.direction,
            isAnomaly: Math.abs(sessionsDev.deviationPct) > 20 || sessionsDev.deviationSigma > sigmaThreshold,
          };

          if (wantsConversions) {
            const convDev = deviate(
              baselineDays.map((d) => ({ date: d.date, value: d.conversions ?? 0 })),
              recentDays.map((d) => ({ date: d.date, value: d.conversions ?? 0 })),
            );
            precomputed.conversions = {
              metric: "Daily Conversions",
              baselineAvgDaily: Math.round(convDev.baselineAvg * 100) / 100,
              recentAvgDaily: Math.round(convDev.recentAvg * 100) / 100,
              deviationPct: convDev.deviationPct,
              deviationSigma: convDev.deviationSigma,
              direction: convDev.direction,
              isAnomaly: Math.abs(convDev.deviationPct) > 20 || convDev.deviationSigma > sigmaThreshold,
            };
          }
          if (wantsRevenue) {
            const revDev = deviate(
              baselineDays.map((d) => ({ date: d.date, value: d.revenue ?? 0 })),
              recentDays.map((d) => ({ date: d.date, value: d.revenue ?? 0 })),
            );
            precomputed.revenue = {
              metric: "Daily Revenue",
              baselineAvgDaily: Math.round(revDev.baselineAvg * 100) / 100,
              recentAvgDaily: Math.round(revDev.recentAvg * 100) / 100,
              deviationPct: revDev.deviationPct,
              deviationSigma: revDev.deviationSigma,
              direction: revDev.direction,
              isAnomaly: Math.abs(revDev.deviationPct) > 20 || revDev.deviationSigma > sigmaThreshold,
            };
          }

          liveBlocks.push(`GA4 daily history (last 90 days, property ${propertyId}):\n${JSON.stringify(dailyRows, null, 2)}`);
        }
      }
      // Fewer than 8 days of history is a real, connected state (a brand new
      // property) — still "live", just nothing to baseline against yet.
      ga4Live = true;
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Analytics 4", err instanceof Error ? err.message : String(err));
    }
  }

  // --- GSC: clicks/impressions anomaly, when traffic is in scope ---
  if (wantsTraffic) {
    const gscIntegration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "GOOGLE_SEARCH_CONSOLE" } },
    });

    if (gscIntegration) {
      try {
        const creds = await googleCredentials(gscIntegration);
        // A submitted dropdown choice wins over the integration's saved
        // default — but it's still just a client string, so it's checked
        // against what this grant can actually reach first.
        const propertyUrl = await resolvePropertyOverride("GOOGLE_SEARCH_CONSOLE", creds, gscSiteOverride);
        if (!propertyUrl) {
          throw new AgentInputError(
            "Google Search Console is connected, but no property has been selected.",
            "Open Integrations → Google Search Console and choose a property, or set a GSC Site URL override on this agent.",
            "integration_not_configured",
          );
        }
        gscPropertyResolved = propertyUrl;

        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        const ninetyDaysAgo = new Date(yesterday);
        ninetyDaysAgo.setDate(yesterday.getDate() - 89);

        const res = await fetch(
          `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(propertyUrl)}/searchAnalytics/query`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${creds.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              startDate: formatDate(ninetyDaysAgo),
              endDate: formatDate(yesterday),
              dimensions: ["date"],
              rowLimit: 100,
            }),
          },
        );
        if (!res.ok) throw new Error(`Search Console API ${res.status}: ${(await res.text()).slice(0, 300)}`);

        const data = (await res.json()) as GscResponse;
        const rows = data.rows ?? [];
        if (rows.length >= 8) {
          const baselineDays = rows.slice(0, rows.length - 7);
          const recentDays = rows.slice(-7);
          const clicksDev = deviate(
            baselineDays.map((r) => ({ date: r.keys[0], value: r.clicks })),
            recentDays.map((r) => ({ date: r.keys[0], value: r.clicks })),
          );
          const impressionsDev = deviate(
            baselineDays.map((r) => ({ date: r.keys[0], value: r.impressions })),
            recentDays.map((r) => ({ date: r.keys[0], value: r.impressions })),
          );
          precomputed.searchClicks = {
            metric: "Daily Search Clicks",
            baselineAvgDaily: Math.round(clicksDev.baselineAvg),
            recentAvgDaily: Math.round(clicksDev.recentAvg),
            deviationPct: clicksDev.deviationPct,
            deviationSigma: clicksDev.deviationSigma,
            direction: clicksDev.direction,
            isAnomaly: Math.abs(clicksDev.deviationPct) > 20 || clicksDev.deviationSigma > sigmaThreshold,
          };
          precomputed.searchImpressions = {
            metric: "Daily Search Impressions",
            baselineAvgDaily: Math.round(impressionsDev.baselineAvg),
            recentAvgDaily: Math.round(impressionsDev.recentAvg),
            deviationPct: impressionsDev.deviationPct,
            deviationSigma: impressionsDev.deviationSigma,
            direction: impressionsDev.direction,
            isAnomaly: Math.abs(impressionsDev.deviationPct) > 20 || impressionsDev.deviationSigma > sigmaThreshold,
          };
          liveBlocks.push(`GSC daily clicks/impressions (last 90 days, property ${propertyUrl}):\n${JSON.stringify(rows, null, 2)}`);
        }
        gscLive = true;
      } catch (err) {
        if (err instanceof AgentInputError) throw err;
        throw liveCallFailed("Google Search Console", err instanceof Error ? err.message : String(err));
      }
    }
  }

  // --- Google Ads: spend/click anomaly, optional ---
  const adsIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "GOOGLE_ADS" } },
  });

  if (adsIntegration) {
    try {
      const creds = await googleCredentials(adsIntegration);
      // A submitted dropdown choice wins over the integration's saved
      // default — but it's still just a client string, so it's checked
      // against what this grant can actually reach first.
      const customerId = await resolvePropertyOverride("GOOGLE_ADS", creds, adsCustomerOverride.replace(/-/g, ""));
      if (!customerId) {
        throw new AgentInputError(
          "Google Ads is connected, but no account has been selected.",
          "Open Integrations → Google Ads and choose an account, or set a Google Ads Customer ID override on this agent.",
          "integration_not_configured",
        );
      }
      adsCustomerResolved = customerId;

      const adsRes = await fetch(
        `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`,
        {
          method: "POST",
          headers: googleAdsHeaders(creds.access_token),
          body: JSON.stringify({
            // Campaign-level (not customer-level) — the same resource
            // google-ads.ts already queries successfully in this codebase —
            // segmented by day and summed client-side below, since a multi-
            // campaign account returns one row per campaign per day.
            query:
              "SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions FROM campaign WHERE segments.date DURING LAST_30_DAYS",
          }),
        },
      );
      if (!adsRes.ok) throw new Error(`Google Ads API ${adsRes.status}: ${(await adsRes.text()).slice(0, 300)}`);

      const chunks = (await adsRes.json()) as AdsStreamChunk[];
      const byDate = new Map<string, number>();
      for (const row of chunks.flatMap((c) => c.results ?? [])) {
        const date = row.segments.date;
        byDate.set(date, (byDate.get(date) ?? 0) + Number(row.metrics.costMicros) / 1_000_000);
      }
      const dailySpend = Array.from(byDate.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, value }));

      if (dailySpend.length >= 8) {
        const baselineDays = dailySpend.slice(0, dailySpend.length - 7);
        const recentDays = dailySpend.slice(-7);
        const spendDev = deviate(baselineDays, recentDays);
        precomputed.adSpend = {
          metric: "Daily Ad Spend",
          baselineAvgDaily: Math.round(spendDev.baselineAvg * 100) / 100,
          recentAvgDaily: Math.round(spendDev.recentAvg * 100) / 100,
          deviationPct: spendDev.deviationPct,
          deviationSigma: spendDev.deviationSigma,
          direction: spendDev.direction,
          isAnomaly: Math.abs(spendDev.deviationPct) > 20 || spendDev.deviationSigma > sigmaThreshold,
        };
        liveBlocks.push(`Google Ads daily spend (last 30 days, customer ${customerId}): ${JSON.stringify(dailySpend)}`);
      }
      adsLive = true;
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Ads", err instanceof Error ? err.message : String(err));
    }
  }

  const source = ga4Live || gscLive || adsLive ? "live" : "simulation";

  const liveDataSection =
    liveBlocks.length > 0
      ? `\n\nLIVE DATA — use the pre-computed baseline analysis below to populate the anomalies and allClear arrays with accurate values. Do not invent data for any metric listed here:\n\nPre-computed anomaly analysis:\n${JSON.stringify(precomputed, null, 2)}\n\nFull daily history (for additional context):\n${liveBlocks.join("\n\n")}`
      : "";

  const systemPrompt = `You are a marketing analytics anomaly detection specialist.
Only flag genuine statistical anomalies (>${sigmaThreshold} sigma from baseline). Never alert on normal daily variance.
${correlateDeployDates ? "Always correlate anomalies with known events (deploys, campaigns, seasonality) before escalating." : "Report each anomaly's magnitude and direction without speculating about deploys or campaign changes."}
Distinguish between true anomalies and expected patterns (weekend dips, post-launch surges, seasonal cycles).
Return ONLY valid JSON — no markdown fences, no preamble.`;

  const reportDate = formatDate(new Date());

  const userPrompt = `Perform anomaly detection analysis for:
- GA4 property: ${ga4PropertyResolved || "not connected"}
- GSC property: ${gscPropertyResolved || "not connected"}
- Google Ads account: ${adsCustomerResolved || "not connected"}

Business context:
${businessContext || "No business profile configured."}

Analysis parameters:
- Tracked metrics: ${metricsScope}
- Sensitivity level: ${sensitivityLevel} (flag deviations >${sigmaThreshold} sigma)
- Correlate with deploy dates: ${correlateDeployDates}
- Alert recipients: ${alertRecipients || "None configured"}
- Report date: ${reportDate}
${skippedForLowTraffic ? `\nGA4 baseline average daily sessions is below the configured minimum (${minimumSessionThreshold}) — omit a sessions anomaly entry and note this in allClear instead of guessing.` : ""}
${liveDataSection}

${source === "live" ? "Use the real data above to populate anomalies with accurate baselines, deviations, and directions. Only include a metric in anomalies or allClear if it appears in the pre-computed analysis or the tracked-metrics scope explicitly requests it as simulated." : `Simulate a realistic anomaly detection run for this property. Generate anomalies that would actually warrant attention for a ${businessProfile?.industry ?? "general"} business — not every metric will have anomalies.`}

Return this exact JSON structure:
${JSON.stringify({
  reportDate,
  ga4Property: ga4PropertyResolved,
  gscProperty: gscPropertyResolved,
  googleAdsCustomerId: adsCustomerResolved,
  period: "Last 7 days vs prior baseline",
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
    "Connect GA4, Google Search Console, and Google Ads in Settings to monitor real metric baselines. This report simulates anomaly detection based on your property configuration.",
})}

${source === "live" ? "Base every anomaly/allClear entry that corresponds to a pre-computed metric on those exact values. Set alertsSent to an empty array — no notification channel is wired up yet regardless of alertRecipients." : `Make anomaly values realistic for a ${businessProfile?.industry ?? "general"} business. Include 1-3 genuine anomalies and 4-6 all-clear metrics. Populate correlatedEvents with realistic possibilities (e.g., "Weekend traffic pattern", "Recent blog publish", "Seasonal variation"). Set alertsSent to an empty array.`}`;

  const message = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 4096,
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
  output.sources = {
    ga4: ga4Live ? "live" : "simulation",
    gsc: wantsTraffic ? (gscLive ? "live" : "simulation") : "not tracked",
    googleAds: adsLive ? "live" : "not connected",
  };

  if (source === "simulation") {
    output.simulationNote =
      "Connect GA4, Google Search Console, and Google Ads in Settings to monitor real metric baselines. This report simulates anomaly detection based on your property configuration.";
  }
  // Priced from lib/ai/models.ts — Haiku 4.5 is $1/M input, $5/M output.
  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
