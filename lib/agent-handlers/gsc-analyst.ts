import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

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

  const userPrompt = `Generate a ${comparisonPeriod} GSC report for ${businessProfile?.businessName ?? "this website"} (${gscProperty || "property not set"}).

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
  output.simulationNote =
    "Connect Google Search Console in Settings to pull live query, page, device, and country data. Real integration enables automated weekly scheduling with Slack/email delivery.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
