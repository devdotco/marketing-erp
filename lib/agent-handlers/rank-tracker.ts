import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

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

  const systemPrompt = `You are an SEO rank tracking analyst. Your job is to simulate daily position tracking data, identify meaningful trend breaks, and flag changes that exceed normal movement bands.

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

  const userPrompt = `Simulate daily rank tracking for this keyword set for a ${businessProfile?.businessName ?? "business"} website.

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
  output.simulationNote =
    "Connect Google Search Console in Settings to enable live daily rank tracking. Real integration also pulls Ahrefs/Semrush rank data for cross-validation and competitor domain tracking.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
