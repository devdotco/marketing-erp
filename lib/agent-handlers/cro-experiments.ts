import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { googleCredentials, liveCallFailed } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

interface Ga4Row {
  dimensionValues: Array<{ value: string }>;
  metricValues: Array<{ value: string }>;
}

interface Ga4Response {
  rows?: Ga4Row[];
}

export const croExperimentsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const targetUrls = lines(config, "targetUrls", 10);
  const pageUrl = targetUrls[0] ?? "Not specified";
  const conversionGoal = str(config, "primaryConversionEvent", "Not specified");
  const trafficMonthly = num(config, "monthlyUniqueVisitors", 10000, { min: 0 });
  const hypothesisCount = num(config, "hypothesesPerRun", 5, { min: 1, max: 10 });
  // Optional, no default: blank means unknown, not 0%.
  const baselineConvRate = str(config, "baselineConvRate") ? num(config, "baselineConvRate", 0, { min: 0, max: 100 }) : null;
  const analysisDays = num(config, "analysisDateRange", 90, { min: 7, max: 365 });
  const experimentLogFormat = str(config, "experimentLogFormat", "Markdown table");
  // "" rather than a placeholder string: resolvePropertyOverride below treats
  // a non-empty value as a real dropdown choice to verify against the
  // connected grant, so a fake fallback here would fail every run that
  // didn't explicitly pick something.
  const ga4Property = (config.ga4Property as string) ?? "";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  // --- Live GA4 Landing Page Metrics ---
  let livePageBlock: string | null = null;
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
      const creds = await googleCredentials(ga4Integration);
      // A submitted dropdown choice wins over the integration's saved
      // default — but it's still just a client string, so it's checked
      // against what this grant can actually reach first.
      const ga4PropertyId = await resolvePropertyOverride("GOOGLE_ANALYTICS_4", creds, ga4Property);
      if (!ga4PropertyId) {
        throw new AgentInputError(
          "Google Analytics 4 is connected, but no property has been selected.",
          "Open Integrations → Google Analytics 4 and choose a property.",
          "integration_not_configured",
        );
      }

      // Fetch top landing pages by sessions with bounce rate, conversions, avg session duration
      const ga4Res = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${ga4PropertyId}:runReport`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dateRanges: [{ startDate: `${analysisDays}daysAgo`, endDate: "today" }],
            dimensions: [{ name: "pagePath" }],
            metrics: [
              { name: "sessions" },
              { name: "bounceRate" },
              { name: "conversions" },
              { name: "averageSessionDuration" },
            ],
            orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
            limit: 20,
          }),
        }
      );
      if (!ga4Res.ok) {
        throw new Error(`GA4 Data API ${ga4Res.status}: ${(await ga4Res.text()).slice(0, 300)}`);
      }

      const ga4Data = (await ga4Res.json()) as Ga4Response;
      const pages = (ga4Data.rows ?? []).map((row) => ({
        pagePath: row.dimensionValues[0]?.value ?? "/",
        sessions: Number(row.metricValues[0]?.value ?? 0),
        bounceRate: Math.round(Number(row.metricValues[1]?.value ?? 0) * 1000) / 10,
        conversions: Number(row.metricValues[2]?.value ?? 0),
        avgSessionDurationSec: Math.round(Number(row.metricValues[3]?.value ?? 0)),
      }));

      // Find each target URL in the results (the first one is the primary page)
      const targetMatches = targetUrls
        .map((u) => u.replace(/^https?:\/\/[^/]+/, "") || "/")
        .map((path) => pages.find((p) => (path === "/" ? p.pagePath === "/" : p.pagePath.includes(path))))
        .filter((p): p is (typeof pages)[number] => Boolean(p));

      const targetPage = targetMatches[0] ?? null;

      const realConvRate = targetPage && targetPage.sessions > 0
        ? Math.round((targetPage.conversions / targetPage.sessions) * 10000) / 100
        : null;

      livePageBlock = [
        targetPage
          ? `Target Page Metrics (last ${analysisDays} days):\n${JSON.stringify(targetMatches, null, 2)}`
          : null,
        realConvRate !== null
          ? `Observed conversion rate: ${realConvRate}%`
          : null,
        `Top 20 pages by sessions (for context):\n${JSON.stringify(pages, null, 2)}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      source = "live";
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Analytics 4", err instanceof Error ? err.message : String(err));
    }
  }

  const resolvedConvRate = baselineConvRate;
  const liveDataSection = livePageBlock
    ? `\n\nLIVE GA4 DATA (last ${analysisDays} days) — use real bounce rate, session duration, and conversion rate to ground your hypotheses and sample size calculations:\n${livePageBlock}`
    : "";

  const systemPrompt = `You are a conversion rate optimisation specialist. Hypotheses must specify mechanism (WHY will this change behaviour) not just what to change. Sample size calculations must use correct statistical formulas. Never recommend running more than one test on the same page simultaneously.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const userPrompt = `Generate a CRO experiment plan for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Website: ${businessProfile?.websiteUrl ?? "Not specified"}
Target Audience: ${businessProfile?.targetAudience ?? "Not specified"}
Unique Value Proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}

Page Configuration:
- Page URL: ${pageUrl}
- Funnel Pages (in order): ${targetUrls.length > 0 ? targetUrls.join(" -> ") : "Not specified"}
- Primary Conversion Event (GA4): ${conversionGoal}
- Monthly Traffic: ${trafficMonthly}
- Number of Hypotheses: ${hypothesisCount}
- Baseline Conversion Rate: ${resolvedConvRate !== null ? `${resolvedConvRate}%` : "Unknown"}
- GA4 Property: ${ga4Property || "Not specified"}
${liveDataSection}

Rank hypotheses by where the funnel drops off most between the funnel pages above.
Write experimentLog as a single string formatted as a ${experimentLogFormat}, with one row/entry per hypothesis (hypothesis number, page, change, primary metric, required sample size, estimated duration, status "Proposed").

For sample size calculations, use 80% statistical power, 95% confidence level, and assume a minimum detectable effect of 20% relative lift unless the baseline conversion rate suggests otherwise. Calculate required sample size per variant.

Return a JSON object with this exact structure:
{
  "pageAnalysis": {
    "url": string,
    "conversionGoal": string,
    "currentConversionRate": number | null,
    "identifiedFriction": [string],
    "strengthsToKeep": [string]
  },
  "hypotheses": [
    {
      "hypothesisNumber": number,
      "element": string,
      "currentState": string,
      "proposedChange": string,
      "mechanism": string,
      "expectedLift": string,
      "confidence": "high" | "medium" | "low",
      "effort": "low" | "medium" | "high",
      "priority": number
    }
  ],
  "sampleSizeCalculations": [
    {
      "hypothesisNumber": number,
      "baselineConvRate": number,
      "minimumDetectableEffect": number,
      "requiredSampleSize": number,
      "estimatedRunTimeDays": number,
      "statisticalPower": number
    }
  ],
  "prioritisedTestingRoadmap": string,
  "experimentLog": string,
  "simulationNote": "Connect GA4 in Settings to pull real page performance data. These hypotheses are generated from your page description."
}`;

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

  if (source === "simulation") {
    output.simulationNote =
      "Connect GA4 in Settings to pull real page performance data. These hypotheses are generated from your page description.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { output, costUsd };
};
