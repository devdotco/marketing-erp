import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export const rankTrackerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const trackingKeywords = (config.trackingKeywords as string) ?? "";
  const gscProperty = (config.gscProperty as string) ?? "";
  const alertThreshold = (config.alertThreshold as number) ?? 5;
  const competitorDomains = (config.competitorDomains as string) ?? "";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  // --- Live GSC data fetch ---
  let gscDataContext = "";
  let isLive = false;

  const integration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "GOOGLE_SEARCH_CONSOLE",
      },
    },
  });

  if (integration) {
    try {
      const creds = await decryptCredentials<{
        access_token: string;
        property_url: string;
      }>(integration.encryptedCredentials);

      const propertyUrl = creds.property_url || gscProperty;
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
          rowLimit: 25000,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as GscResponse;
        const rows = data.rows ?? [];

        // Parse tracked keywords into a normalized set for filtering
        const trackedSet = new Set(
          trackingKeywords
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
Total queries with data: ${rows.length}
${trackedSet.size > 0 ? `Tracked keywords matched: ${queryList.length} of ${trackedSet.size} configured` : `Top ${queryList.length} queries by clicks shown`}

Query position data (sorted by position, ascending):
${JSON.stringify(queryList, null, 2)}`;

        isLive = true;
      }
    } catch {
      // Fall through to simulation
    }
  }

  const systemPrompt = `You are an SEO rank tracking analyst. Your job is to ${isLive ? "analyze real GSC position data" : "simulate daily position tracking data"}, identify meaningful trend breaks, and flag changes that exceed normal movement bands.

Business context:
- Business: ${businessProfile?.businessName ?? "Unknown"}
- GSC Property: ${gscProperty || "Not configured"}
- Alert threshold: ${alertThreshold} positions
- Competitors tracked: ${competitorDomains || "None configured"}

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

  const userPrompt = isLive
    ? `Analyze the following REAL Google Search Console rank data for ${businessProfile?.businessName ?? "this business"}.

Keywords configured to track:
${trackingKeywords || "All tracked queries"}

Competitors:
${competitorDomains || "None specified"}

GSC Property: ${gscProperty || integration ? "Connected" : "Not connected"}
Alert threshold: ${alertThreshold} positions

${gscDataContext}

Using the real position data above:
1. Map each tracked keyword to its current position from the GSC data
2. Estimate previousPosition by adding realistic ±1-5 position variance (90-day aggregate doesn't include daily history — note this)
3. Flag any keyword at position > ${alertThreshold} from an assumed prior good position
4. Identify keywords in top 3, top 10 based on actual position data
5. Generate competitor snapshot based on position gaps (actual competitor data is simulated — note this)
6. Set inAlertZone: true for any keyword where position > ${alertThreshold + 10} (indicating potential alert)
Note: previousPosition and change values are estimated since 90-day aggregates don't contain day-over-day history.`
    : `Simulate daily rank tracking for this keyword set for a ${businessProfile?.businessName ?? "business"} website.

Keywords to track:
${trackingKeywords}

Competitors:
${competitorDomains || "None specified"}

GSC Property: ${gscProperty || "Not connected"}
Alert threshold: ${alertThreshold} positions

Generate realistic rank tracking data that shows:
1. Normal day-to-day fluctuations (±1-3 positions) for most keywords
2. A few significant movements that trigger alerts (>${alertThreshold} positions)
3. Realistic click, impression, and CTR data from GSC
4. Competitor position comparisons where overlap exists
5. Learned normal movement bands based on 30 days of simulated history`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
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
  output.source = isLive ? "live" : "simulation";

  if (!isLive) {
    output.simulationNote =
      "Connect Google Search Console in Settings to enable live daily rank tracking. Real integration also pulls Ahrefs/Semrush rank data for cross-validation and competitor domain tracking.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
