import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { googleCredentials, liveCallFailed } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// Search Analytics `device` dimension filter values — see rank-tracker.ts for
// the doc reference (DESKTOP/MOBILE/TABLET, confirmed against
// https://developers.google.com/webmaster-tools/v1/searchanalytics/query).
const DEVICE_CODES: Record<string, string> = {
  Desktop: "DESKTOP",
  Mobile: "MOBILE",
  Tablet: "TABLET",
};

/** Parse "11-20" into [11, 20]; falls back to the striking-distance default on anything unparsable. */
function parseRange(raw: string): [number, number] {
  const match = raw.match(/(\d+)\s*-\s*(\d+)/);
  if (!match) return [11, 20];
  const [, a, b] = match;
  return [Number(a), Number(b)];
}

export const gscAnalystHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const gscPropertyOverride = String(config.gscPropertyUrl ?? "");
  const comparisonPeriod = String(config.comparisonPeriod ?? "WoW");
  const minImpressions = Number(config.minImpressions ?? 50);
  const strikingDistanceRange = String(config.strikingDistanceRange ?? "11-20");
  const deviceSegment = String(config.deviceSegment ?? "All");
  const focusOnPages = String(config.focusOnPages ?? "");
  const includeMetaRewrites = config.includeMetaRewrites !== false;
  const reportFormat = String(config.reportFormat ?? "Narrative");

  const [strikeMin, strikeMax] = parseRange(strikingDistanceRange);
  const focusPrefixes = focusOnPages
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const periodLabels: Record<string, { current: string; previous: string }> = {
    WoW: { current: "last 7 days", previous: "prior 7 days" },
    MoM: { current: "last 28 days", previous: "prior 28 days" },
    YoY: { current: "last 28 days", previous: "same 28 days last year" },
  };
  const periodLabel = periodLabels[comparisonPeriod] ?? periodLabels["WoW"];

  // --- Live GSC data fetch ---
  let gscDataContext = "";
  let isLive = false;
  let resolvedProperty = gscPropertyOverride || businessProfile?.websiteUrl || "";

  const integration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "GOOGLE_SEARCH_CONSOLE",
      },
    },
  });

  // Not connected → simulating below is fine. Connected but the call fails →
  // fail the run rather than quietly ship simulated data as "live".
  if (integration) {
    try {
      // Refreshes the hour-long access token first.
      const creds = await googleCredentials(integration);

      // A submitted dropdown choice wins over the integration's saved
      // default — but it's still just a client string, so it's checked
      // against what this grant can actually reach first.
      const propertyUrl = await resolvePropertyOverride("GOOGLE_SEARCH_CONSOLE", creds, gscPropertyOverride);
      if (!propertyUrl) {
        throw new AgentInputError(
          "Google Search Console is connected, but no property has been selected.",
          "Open Integrations → Google Search Console and choose a property, or set a GSC Property URL override on this agent.",
          "integration_not_configured",
        );
      }
      resolvedProperty = propertyUrl;
      const encodedUrl = encodeURIComponent(propertyUrl);
      const apiBase = `https://www.googleapis.com/webmasters/v3/sites/${encodedUrl}/searchAnalytics/query`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${creds.access_token}`,
        "Content-Type": "application/json",
      };

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);

      const days = comparisonPeriod === "WoW" ? 7 : 28;

      const currentEnd = new Date(yesterday);
      const currentStart = new Date(yesterday);
      currentStart.setDate(yesterday.getDate() - (days - 1));

      let previousEnd = new Date(currentStart);
      previousEnd.setDate(currentStart.getDate() - 1);
      let previousStart = new Date(previousEnd);
      previousStart.setDate(previousEnd.getDate() - (days - 1));

      if (comparisonPeriod === "YoY") {
        previousStart = new Date(currentStart);
        previousStart.setFullYear(currentStart.getFullYear() - 1);
        previousEnd = new Date(currentEnd);
        previousEnd.setFullYear(currentEnd.getFullYear() - 1);
      }

      const deviceCode = DEVICE_CODES[deviceSegment];
      const dimensionFilterGroups = deviceCode
        ? [{ filters: [{ dimension: "device", operator: "equals", expression: deviceCode }] }]
        : undefined;

      type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
      type GscResponse = { rows?: GscRow[] };

      const [currentRes, previousRes] = await Promise.all([
        fetch(apiBase, {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: formatDate(currentStart),
            endDate: formatDate(currentEnd),
            dimensions: ["query", "page"],
            ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
            rowLimit: 25000,
          }),
        }),
        fetch(apiBase, {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: formatDate(previousStart),
            endDate: formatDate(previousEnd),
            dimensions: ["query", "page"],
            ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
            rowLimit: 25000,
          }),
        }),
      ]);
      if (!currentRes.ok || !previousRes.ok) {
        const bad = !currentRes.ok ? currentRes : previousRes;
        throw new Error(`Search Console API ${bad.status}: ${(await bad.text()).slice(0, 300)}`);
      }

      const currentData = (await currentRes.json()) as GscResponse;
      const previousData = (await previousRes.json()) as GscResponse;

      let currentRows = currentData.rows ?? [];
      let previousRows = previousData.rows ?? [];

      // Focus URL paths — restrict to configured section(s) of the site.
      if (focusPrefixes.length > 0) {
        const matchesFocus = (page: string) => focusPrefixes.some((prefix) => page.includes(prefix));
        currentRows = currentRows.filter((r) => matchesFocus(r.keys[1]));
        previousRows = previousRows.filter((r) => matchesFocus(r.keys[1]));
      }

      // Minimum impressions — drop low-signal noise from both periods.
      currentRows = currentRows.filter((r) => r.impressions >= minImpressions);

      // Build lookup by query key
      const prevMap = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
      for (const row of previousRows) {
        const existing = prevMap.get(row.keys[0]);
        if (!existing || row.clicks > existing.clicks) {
          prevMap.set(row.keys[0], {
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          });
        }
      }

      const currentTotal = currentRows.reduce(
        (acc, r) => ({ clicks: acc.clicks + r.clicks, impressions: acc.impressions + r.impressions }),
        { clicks: 0, impressions: 0 }
      );
      const previousTotal = previousRows.reduce(
        (acc, r) => ({ clicks: acc.clicks + r.clicks, impressions: acc.impressions + r.impressions }),
        { clicks: 0, impressions: 0 }
      );

      const currentAvgPos =
        currentRows.length > 0
          ? currentRows.reduce((s, r) => s + r.position, 0) / currentRows.length
          : 0;
      const previousAvgPos =
        previousRows.length > 0
          ? previousRows.reduce((s, r) => s + r.position, 0) / previousRows.length
          : 0;

      // Top 200 rows by current clicks with previous period comparison
      const topRows = [...currentRows]
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 200)
        .map((r) => {
          const prev = prevMap.get(r.keys[0]);
          return {
            query: r.keys[0],
            page: r.keys[1],
            clicks: r.clicks,
            prevClicks: prev?.clicks ?? 0,
            impressions: r.impressions,
            prevImpressions: prev?.impressions ?? 0,
            ctr: r.ctr,
            position: r.position,
            prevPosition: prev?.position ?? null,
          };
        });

      // Striking-distance rows within the configured position range, above
      // the impression floor — computed here so the model isn't guessing
      // which rows qualify.
      const strikingDistanceRows = currentRows
        .filter((r) => r.position >= strikeMin && r.position <= strikeMax)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 40)
        .map((r) => ({ query: r.keys[0], page: r.keys[1], position: r.position, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr }));

      gscDataContext = `REAL GSC DATA — ${comparisonPeriod} comparison (${periodLabel.current} vs ${periodLabel.previous})
Property: ${propertyUrl}
Device filter: ${deviceCode ?? "none (all devices)"}
Focus paths: ${focusPrefixes.join(", ") || "none (whole site)"}
Minimum impressions: ${minImpressions}
Current period: ${formatDate(currentStart)} to ${formatDate(currentEnd)}
Previous period: ${formatDate(previousStart)} to ${formatDate(previousEnd)}

Aggregate totals:
- Current clicks: ${currentTotal.clicks} | Previous clicks: ${previousTotal.clicks}
- Current impressions: ${currentTotal.impressions} | Previous impressions: ${previousTotal.impressions}
- Current avg position: ${currentAvgPos.toFixed(2)} | Previous avg position: ${previousAvgPos.toFixed(2)}
- Total queries in current period (after filters): ${currentRows.length}

Top 200 queries by clicks (with previous period comparison):
${JSON.stringify(topRows, null, 2)}

Queries in striking distance (positions ${strikeMin}-${strikeMax}, sorted by impressions):
${JSON.stringify(strikingDistanceRows, null, 2)}`;

      isLive = true;
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Search Console", err instanceof Error ? err.message : String(err));
    }
  }

  const systemPrompt = `You are a senior SEO analyst specializing in Google Search Console data interpretation. Your job is to produce a ${reportFormat}-format weekly GSC report.

Business context:
- Business: ${businessProfile?.businessName ?? "Unknown"}
- GSC Property: ${resolvedProperty || "Not configured"}
- Comparison: ${comparisonPeriod} (${periodLabel.current} vs ${periodLabel.previous})
- Striking distance range: positions ${strikeMin}-${strikeMax}
- Minimum impressions: ${minImpressions}
- Focus paths: ${focusPrefixes.join(", ") || "whole site"}
- Report format: ${reportFormat}
- Generate meta rewrites: ${includeMetaRewrites}

Return ONLY valid JSON with no markdown fencing or explanation. Follow this exact structure:
{
  "period": {
    "current": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "previous": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "comparison": "WoW|MoM|YoY"
  },
  "toplineMetrics": {
    "clicks": { "current": 4821, "previous": 4103, "change": 718, "changePercent": 17.5 },
    "impressions": { "current": 98400, "previous": 91200, "change": 7200, "changePercent": 7.9 },
    "avgCtr": { "current": 0.049, "previous": 0.045, "change": 0.004 },
    "avgPosition": { "current": 18.3, "previous": 19.7, "change": -1.4 }
  },
  "strikingDistance": [
    {
      "query": "keyword phrase",
      "currentPosition": 13.4,
      "clicks7d": 28,
      "impressions7d": 1840,
      "ctr": 0.015,
      "estimatedClicksAtTop10": 185,
      "contentUrl": "https://example.com/page",
      "recommendedAction": "specific optimization tip",
      "effort": "low|medium|high",
      "priorityScore": 92
    }
  ],
  "wins": [
    {
      "query": "keyword",
      "positionChange": -4.2,
      "clickChange": 112,
      "clickChangePercent": 38.1,
      "explanation": "why it improved"
    }
  ],
  "losses": [
    {
      "query": "keyword",
      "positionChange": 6.8,
      "clickChange": -87,
      "clickChangePercent": -29.3,
      "explanation": "likely cause",
      "recoveryAction": "recommended fix"
    }
  ],
  "contentOpportunities": [
    {
      "query": "high-impression low-click keyword",
      "impressions": 4200,
      "clicks": 12,
      "ctr": 0.003,
      "avgPosition": 8.2,
      "issue": "title mismatch|meta description|content gap",
      "fix": "specific recommendation"${includeMetaRewrites ? `,
      "metaRewrite": { "title": "rewritten title tag (≤60 chars)", "metaDescription": "rewritten meta description (≤155 chars)" }` : ""}
    }
  ],
  "narrative": "Full written ${reportFormat}-style analysis of the period...",
  "keyTakeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3"],
  "nextWeekFocus": ["Action 1", "Action 2", "Action 3"]
}`;

  const userPrompt = isLive
    ? `Analyze the following REAL Google Search Console data for ${businessProfile?.businessName ?? "this website"} and generate a ${comparisonPeriod} GSC report.

Report format: ${reportFormat}
Striking distance: positions ${strikeMin}-${strikeMax}

${gscDataContext}

Use the real data above to:
1. Calculate topline metrics with real ${comparisonPeriod} deltas (derive avg CTR from totals)
2. Build strikingDistance directly from the "Queries in striking distance" list above — do not invent rows outside it
3. Top 5 wins (biggest positive position or click change) and top 5 losses (biggest drops), from the top-200 query list
4. Content opportunities (high impressions, low CTR) from the same list${includeMetaRewrites ? ", each with a metaRewrite" : " — omit metaRewrite from every entry since meta rewrites were not requested"}
5. A ${reportFormat.toLowerCase()} narrative based on the actual data
${reportFormat === "Executive" ? "Keep the narrative to 3 bullet points maximum." : ""}
${reportFormat === "Narrative" ? "Write a flowing 3-paragraph narrative with specific examples from the data." : ""}
${reportFormat === "Bullet" ? "Use concise bullet points throughout. No long paragraphs." : ""}`
    : `Generate a ${comparisonPeriod} GSC report for ${businessProfile?.businessName ?? "this website"} (${resolvedProperty || "property not set"}).

Report format: ${reportFormat}
Comparison period: ${periodLabel.current} vs ${periodLabel.previous}
Striking distance: positions ${strikeMin}-${strikeMax}
Minimum impressions: ${minImpressions}
Focus paths: ${focusPrefixes.join(", ") || "whole site"}

Produce realistic simulated Search Console data that includes:
1. Topline metrics with realistic WoW/MoM deltas (clicks, impressions, CTR, avg position)
2. At least 8 striking-distance queries (positions ${strikeMin}-${strikeMax}) ranked by opportunity score
3. Top 5 wins and top 5 losses with explanations
4. Content opportunities (high impressions, low CTR) with specific fixes${includeMetaRewrites ? ", each with a metaRewrite" : " — omit metaRewrite from every entry since meta rewrites were not requested"}
5. A ${reportFormat.toLowerCase()} narrative analysis appropriate for sharing with stakeholders
${reportFormat === "Executive" ? "Keep the narrative to 3 bullet points maximum." : ""}
${reportFormat === "Narrative" ? "Write a flowing 3-paragraph narrative with specific examples." : ""}
${reportFormat === "Bullet" ? "Use concise bullet points throughout. No long paragraphs." : ""}`;

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
  output.source = isLive ? "live (Google Search Console)" : "simulation";

  if (!isLive) {
    output.simulationNote =
      "Connect Google Search Console in Settings to pull live query, page, device, and country data. Real integration enables automated weekly scheduling with Slack/email delivery.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { output, costUsd };
};
