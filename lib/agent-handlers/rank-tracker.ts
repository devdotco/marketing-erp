import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { googleCredentials, liveCallFailed } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import {
  bareDomain,
  fetchAhrefsOrganicKeywords,
  fetchSearchAtlasKeywordGap,
  fetchSemrushDomainOrganic,
  resolveSeoLiveData,
} from "./seo-data-providers";

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// Search Analytics `device` dimension filter values. Confirmed against
// https://developers.google.com/webmaster-tools/v1/searchanalytics/query
// ("Supported values: DESKTOP, MOBILE, TABLET").
const DEVICE_CODES: Record<string, string> = {
  Desktop: "DESKTOP",
  Mobile: "MOBILE",
  Tablet: "TABLET",
};

// Search Analytics `country` dimension filter takes ISO 3166-1 alpha-3, not
// alpha-2 — confirmed against the same reference. The old "us"/"gb" options
// here were never valid filter values, so countryFilter silently filtered
// nothing.
const COUNTRY_CODES: Record<string, string> = {
  "United States": "USA",
  "United Kingdom": "GBR",
  "Australia": "AUS",
  "Canada": "CAN",
  "Germany": "DEU",
};

export const rankTrackerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const targetKeywords = String(config.targetKeywords ?? "");
  const gscPropertyOverride = String(config.gscPropertyUrl ?? "");
  const movementThreshold = Number(config.movementThreshold ?? 3);
  const deviceSegment = String(config.deviceSegment ?? "All");
  const countryFilter = String(config.countryFilter ?? "All");
  const alertOnLoss = config.alertOnLoss !== false;
  const competitorDomains = String(config.competitorDomains ?? "");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  // --- Live GSC data fetch (own rankings) ---
  let gscDataContext = "";
  let isLive = false;
  let resolvedProperty = gscPropertyOverride;

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
      const ninetyDaysAgo = new Date(yesterday);
      ninetyDaysAgo.setDate(yesterday.getDate() - 89);

      const deviceCode = DEVICE_CODES[deviceSegment];
      const countryCode = COUNTRY_CODES[countryFilter];
      const dimensionFilterGroups = [
        deviceCode ? { filters: [{ dimension: "device", operator: "equals", expression: deviceCode }] } : null,
        countryCode ? { filters: [{ dimension: "country", operator: "equals", expression: countryCode }] } : null,
      ].filter(Boolean);

      type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
      type GscResponse = { rows?: GscRow[] };

      // Fetch last 90 days of data by query
      const res = await fetch(apiBase, {
        method: "POST",
        headers,
        body: JSON.stringify({
          startDate: formatDate(ninetyDaysAgo),
          endDate: formatDate(yesterday),
          dimensions: ["query", "page"],
          ...(dimensionFilterGroups.length > 0 ? { dimensionFilterGroups } : {}),
          rowLimit: 25000,
        }),
      });
      if (!res.ok) {
        throw new Error(`Search Console API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const data = (await res.json()) as GscResponse;
      const rows = data.rows ?? [];

      // Parse tracked keywords into a normalized set for filtering
      const trackedSet = new Set(
        targetKeywords
          .split(/[\n,]+/)
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean)
      );

      // Filter to tracked keywords if configured, otherwise take top 500 by clicks
      const filteredRows =
        trackedSet.size > 0
          ? rows.filter((r) => trackedSet.has(r.keys[0].toLowerCase()))
          : rows.sort((a, b) => b.clicks - a.clicks).slice(0, 500);

      // Aggregate by query (sum across pages)
      const queryMap = new Map<
        string,
        { page: string; clicks: number; impressions: number; ctr: number; position: number }
      >();
      for (const row of filteredRows) {
        const query = row.keys[0];
        const existing = queryMap.get(query);
        if (!existing || row.clicks > existing.clicks) {
          queryMap.set(query, {
            page: row.keys[1],
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          });
        }
      }

      const queryList = Array.from(queryMap.entries())
        .sort(([, a], [, b]) => a.position - b.position)
        .map(([query, d]) => ({
          query,
          position: d.position,
          page: d.page,
          clicks90d: d.clicks,
          impressions90d: d.impressions,
          ctr90d: d.ctr,
        }));

      gscDataContext = `REAL GSC DATA — Last 90 days (${formatDate(ninetyDaysAgo)} to ${formatDate(yesterday)})
Property: ${propertyUrl}
Device filter: ${deviceCode ?? "none (all devices)"} | Country filter: ${countryCode ?? "none (all countries)"}
Total queries with data: ${rows.length}
${trackedSet.size > 0 ? `Tracked keywords matched: ${queryList.length} of ${trackedSet.size} configured` : `Top ${queryList.length} queries by clicks shown`}

Query position data (sorted by position, ascending):
${JSON.stringify(queryList, null, 2)}`;

      isLive = true;
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Search Console", err instanceof Error ? err.message : String(err));
    }
  }

  // --- Live competitor data (Ahrefs → Semrush → SearchAtlas) ---
  // GSC only ever sees your own property, so competitor rankings need a
  // separate SEO data source. Mirrors the fallback chain competitor-watch
  // uses for the same reason.
  const competitorDomainList = competitorDomains
    .split(/[\n,]+/)
    .map(bareDomain)
    .filter(Boolean)
    .slice(0, 3);

  let competitorSection = "";
  let competitorSource: "live" | "simulation" | "none" = "none";

  if (competitorDomainList.length > 0) {
    const primaryDomain = bareDomain(businessProfile?.websiteUrl ?? resolvedProperty ?? "");
    const liveResult = await resolveSeoLiveData(
      run.agentConfig.workspaceId,
      (data, provider) =>
        provider === "AHREFS"
          ? `\n\nLIVE AHREFS ORGANIC KEYWORD DATA per competitor:\n${JSON.stringify(data, null, 2)}\n\nUse this to build competitorSnapshot — which of your tracked keywords each competitor also ranks for, and their positions.`
          : provider === "SEMRUSH"
            ? `\n\nLIVE SEMRUSH DOMAIN ORGANIC DATA per competitor (columns: Ph=keyword, Po=position, Nq=monthly searches, Cp=CPC):\n${JSON.stringify(data, null, 2)}\n\nUse this to build competitorSnapshot the same way.`
            : `\n\nLIVE SEARCHATLAS KEYWORD GAP DATA — keywords these competitors rank for that ${primaryDomain} does not:\n${JSON.stringify(data, null, 2)}\n\nUse this as direct evidence for competitorSnapshot's theirWins — these are keywords the client is provably missing, not estimates.`,
      {
        ahrefs: async (apiKey) =>
          Promise.all(
            competitorDomainList.map(async (domain) => ({ domain, data: await fetchAhrefsOrganicKeywords(apiKey, domain) })),
          ),
        semrush: async (apiKey) =>
          Promise.all(
            competitorDomainList.map(async (domain) => ({ domain, data: await fetchSemrushDomainOrganic(apiKey, domain) })),
          ).then((r) => JSON.stringify(r)),
        searchAtlas: primaryDomain
          ? (apiKey) => fetchSearchAtlasKeywordGap(apiKey, primaryDomain, competitorDomainList)
          : undefined,
      },
    );
    if (liveResult.source === "live") {
      competitorSection = liveResult.section;
      competitorSource = "live";
    } else {
      competitorSource = "simulation";
    }
  }

  const systemPrompt = `You are an SEO rank tracking analyst. Your job is to ${isLive ? "analyze real GSC position data" : "simulate daily position tracking data"}, identify meaningful trend breaks, and flag changes that exceed normal movement bands.

Business context:
- Business: ${businessProfile?.businessName ?? "Unknown"}
- GSC Property: ${resolvedProperty || "Not configured"}
- Alert threshold: ${movementThreshold} positions
- Alert emphasis: ${alertOnLoss ? "rank losses (report gains too, but lead with drops)" : "both gains and losses equally"}
- Competitors tracked: ${competitorDomainList.join(", ") || "None configured"}

Return ONLY valid JSON with no markdown fencing or explanation. Follow this exact structure:
{
  "trackingDate": "YYYY-MM-DD",
  "gscProperty": "https://example.com",
  "rankings": [
    {
      "keyword": "keyword phrase",
      "currentPosition": 8,
      "previousPosition": 12,
      "change": 4,
      "weeklyTrend": "up|down|stable",
      "url": "https://example.com/page",
      "device": "desktop|mobile",
      "country": "US",
      "clicks7d": 142,
      "impressions7d": 3200,
      "ctr7d": 0.044,
      "inAlertZone": false,
      "alertType": null,
      "normalBand": { "min": -3, "max": 3 }
    }
  ],
  "alerts": [
    {
      "keyword": "keyword phrase",
      "type": "drop|gain",
      "magnitude": 8,
      "severity": "critical|high|medium|low",
      "previousPosition": 5,
      "currentPosition": 13,
      "url": "https://example.com/page",
      "possibleCause": "likely explanation",
      "recommendedAction": "what to do"
    }
  ],
  "competitorSnapshot": [
    {
      "domain": "competitor.com",
      "keywordsTrackedOverlap": 24,
      "avgPositionVsYou": -2.3,
      "theirWins": 3,
      "yourWins": 5,
      "tied": 16
    }
  ],
  "trendBands": {
    "learnedNormalFluctuation": 2.8,
    "alertThresholdUsed": 5,
    "daysLearned": 30
  },
  "summary": {
    "keywordsTracked": 45,
    "avgPosition": 14.2,
    "avgPositionChange": 1.1,
    "gainingKeywords": 18,
    "losingKeywords": 9,
    "stableKeywords": 18,
    "alertsFired": 3,
    "top10Count": 12,
    "top3Count": 4
  }
}`;

  const userPrompt = `${isLive
    ? `Analyze the following REAL Google Search Console rank data for ${businessProfile?.businessName ?? "this business"}.`
    : `Simulate daily rank tracking for this keyword set for a ${businessProfile?.businessName ?? "business"} website.`}

Keywords configured to track:
${targetKeywords || "All tracked queries"}

Competitors:
${competitorDomainList.join(", ") || "None specified"}

GSC Property: ${resolvedProperty || "Not connected"}
Alert threshold: ${movementThreshold} positions
${gscDataContext}
${competitorSection}

${isLive
    ? `Using the real position data above:
1. Map each tracked keyword to its current position from the GSC data
2. Estimate previousPosition by adding realistic ±1-5 position variance (90-day aggregate doesn't include daily history — note this)
3. Flag any keyword at position > ${movementThreshold} from an assumed prior good position
4. Identify keywords in top 3, top 10 based on actual position data
5. Set inAlertZone: true for any keyword where position > ${movementThreshold + 10} (indicating potential alert)
Note: previousPosition and change values are estimated since 90-day aggregates don't contain day-over-day history.`
    : `Generate realistic rank tracking data that shows:
1. Normal day-to-day fluctuations (±1-3 positions) for most keywords
2. A few significant movements that trigger alerts (>${movementThreshold} positions)
3. Realistic click, impression, and CTR data from GSC
4. Learned normal movement bands based on 30 days of simulated history`}
${competitorSource === "live"
    ? "6. Build competitorSnapshot directly from the live competitor keyword data above — these numbers must reflect real overlap, not guesses."
    : competitorDomainList.length > 0
      ? "6. Competitor data is not live (no Ahrefs/Semrush/SearchAtlas connected) — generate a plausible competitorSnapshot and say so in competitorDataNote."
      : "6. Set competitorSnapshot to an empty array (no competitor domains configured)."}`;

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
  // Overall source reflects the primary signal (your own rankings). Sources
  // below label each portion individually, since the two can differ.
  output.source = isLive ? "live" : "simulation";
  output.sources = {
    ownRankings: isLive ? "live (Google Search Console)" : "simulation",
    competitors:
      competitorSource === "live"
        ? "live (Ahrefs/Semrush/SearchAtlas)"
        : competitorSource === "simulation"
          ? "simulation"
          : "not configured",
  };

  if (!isLive) {
    output.simulationNote =
      "Connect Google Search Console in Settings to enable live daily rank tracking for your own keywords.";
  }
  if (competitorSource === "simulation") {
    output.competitorDataNote =
      "Connect Ahrefs, Semrush, or SearchAtlas in Settings to pull real competitor rankings — GSC cannot see competitor domains.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { output, costUsd };
};
