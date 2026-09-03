import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export const gscAnalystHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const gscProperty = (config.gscProperty as string) ?? "";
  const comparisonPeriod = (config.comparisonPeriod as string) ?? "WoW";
  const strikingDistanceRange = (config.strikingDistanceRange as string) ?? "11-20";
  const reportFormat = (config.reportFormat as string) ?? "Narrative";

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
            rowLimit: 25000,
          }),
        }),
      ]);

      if (currentRes.ok && previousRes.ok) {
        const currentData = (await currentRes.json()) as GscResponse;
        const previousData = (await previousRes.json()) as GscResponse;

        const currentRows = currentData.rows ?? [];
        const previousRows = previousData.rows ?? [];

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

        gscDataContext = `REAL GSC DATA — ${comparisonPeriod} comparison (${periodLabel.current} vs ${periodLabel.previous})
Property: ${propertyUrl}
Current period: ${formatDate(currentStart)} to ${formatDate(currentEnd)}
Previous period: ${formatDate(previousStart)} to ${formatDate(previousEnd)}

Aggregate totals:
- Current clicks: ${currentTotal.clicks} | Previous clicks: ${previousTotal.clicks}
- Current impressions: ${currentTotal.impressions} | Previous impressions: ${previousTotal.impressions}
- Current avg position: ${currentAvgPos.toFixed(2)} | Previous avg position: ${previousAvgPos.toFixed(2)}
- Total queries in current period: ${currentRows.length}

Top 200 queries by clicks (with previous period comparison):
${JSON.stringify(topRows, null, 2)}`;

        isLive = true;
      }
    } catch {
      // Fall through to simulation
    }
  }

  const systemPrompt = `You are a senior SEO analyst specializing in Google Search Console data interpretation. Your job is to produce a ${reportFormat}-format weekly GSC report.

Business context:
- Business: ${businessProfile?.businessName ?? "Unknown"}
- GSC Property: ${gscProperty || "Not configured"}
- Comparison: ${comparisonPeriod} (${periodLabel.current} vs ${periodLabel.previous})
- Striking distance range: positions ${strikingDistanceRange}
- Report format: ${reportFormat}

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
      "fix": "specific recommendation"
    }
  ],
  "narrative": "Full written ${reportFormat}-style analysis of the period...",
  "keyTakeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3"],
  "nextWeekFocus": ["Action 1", "Action 2", "Action 3"]
}`;

  const userPrompt = isLive
    ? `Analyze the following REAL Google Search Console data for ${businessProfile?.businessName ?? "this website"} and generate a ${comparisonPeriod} GSC report.

Report format: ${reportFormat}
Striking distance: positions ${strikingDistanceRange}

${gscDataContext}

Use the real data above to:
1. Calculate topline metrics with real ${comparisonPeriod} deltas (derive avg CTR from totals)
2. Identify striking-distance queries (positions ${strikingDistanceRange}) ranked by opportunity score
3. Top 5 wins (biggest positive position or click change) and top 5 losses (biggest drops)
4. Content opportunities (high impressions, low CTR)
5. A ${reportFormat.toLowerCase()} narrative based on the actual data
${reportFormat === "Executive" ? "Keep the narrative to 3 bullet points maximum." : ""}
${reportFormat === "Narrative" ? "Write a flowing 3-paragraph narrative with specific examples from the data." : ""}
${reportFormat === "Bullet" ? "Use concise bullet points throughout. No long paragraphs." : ""}`
    : `Generate a ${comparisonPeriod} GSC report for ${businessProfile?.businessName ?? "this website"} (${gscProperty || "property not set"}).

Report format: ${reportFormat}
Comparison period: ${periodLabel.current} vs ${periodLabel.previous}
Striking distance: positions ${strikingDistanceRange}

Produce realistic simulated Search Console data that includes:
1. Topline metrics with realistic WoW/MoM deltas (clicks, impressions, CTR, avg position)
2. At least 8 striking-distance queries (positions ${strikingDistanceRange}) ranked by opportunity score
3. Top 5 wins and top 5 losses with explanations
4. Content opportunities (high impressions, low CTR) with specific fixes
5. A ${reportFormat.toLowerCase()} narrative analysis appropriate for sharing with stakeholders
${reportFormat === "Executive" ? "Keep the narrative to 3 bullet points maximum." : ""}
${reportFormat === "Narrative" ? "Write a flowing 3-paragraph narrative with specific examples." : ""}
${reportFormat === "Bullet" ? "Use concise bullet points throughout. No long paragraphs." : ""}`;

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
      "Connect Google Search Console in Settings to pull live query, page, device, and country data. Real integration enables automated weekly scheduling with Slack/email delivery.";
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
