import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const outboundCroHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const input = (run.input ?? {}) as Record<string, unknown>;

  const lookbackDays = typeof config.lookbackDays === "number" ? config.lookbackDays : 7;
  const externalMetrics = input.weeklyMetrics as Record<string, unknown> | undefined;

  // Query DB for prospect metrics from the past lookbackDays
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const [allProspects, repliedProspects, interestedProspects, meetingProspects] = await Promise.all([
    prisma.outboundProspect.groupBy({
      by: ["status"],
      where: { workspaceId: run.agentConfig.workspaceId, createdAt: { gte: since } },
      _count: { id: true },
    }),
    prisma.outboundProspect.findMany({
      where: {
        workspaceId: run.agentConfig.workspaceId,
        status: "REPLIED",
        updatedAt: { gte: since },
      },
      include: { play: true },
    }),
    prisma.outboundProspect.findMany({
      where: {
        workspaceId: run.agentConfig.workspaceId,
        status: "INTERESTED",
        interestedAt: { gte: since },
      },
      include: { play: true },
    }),
    prisma.outboundProspect.findMany({
      where: {
        workspaceId: run.agentConfig.workspaceId,
        status: "MEETING_BOOKED",
        meetingBookedAt: { gte: since },
      },
      include: { play: true },
    }),
  ]);

  // Build metrics per play
  const playSlugs = ["DEV-01", "DEV-02", "DEV-03"];
  const metrics = playSlugs.map((slug) => {
    const replied = repliedProspects.filter((p) => p.play.slug === slug).length;
    const interested = interestedProspects.filter((p) => p.play.slug === slug).length;
    const meetings = meetingProspects.filter((p) => p.play.slug === slug).length;
    const total = allProspects
      .filter(() => true) // grouped by status, not play — approximate
      .reduce((acc, g) => acc + g._count.id, 0);

    return { playSlug: slug, prospectsAdded: total, replied, interested, meetings };
  });

  const dbMetricsSummary = JSON.stringify(metrics, null, 2);
  const externalSummary = externalMetrics ? JSON.stringify(externalMetrics, null, 2) : null;

  const systemPrompt = `You are an outbound CRO specialist for Dev.co. Every Friday you review outbound performance metrics per ICP play and make data-driven recommendations.

Your job:
1. Identify which plays are performing above/below expectations
2. Surface winning signals, personas, and messaging angles
3. Recommend next week's volume allocation across the 3 plays
4. Flag any copy or sequence changes worth testing

Benchmark expectations:
- Email reply rate: 3-5% is healthy. <2% = pause and reangle.
- Positive reply rate: >1.5% of emails sent. <0.5% = reconsider the offer angle.
- LinkedIn accept rate: 25-40% of connection requests.
- Meetings: 1 per 200 contacts is the floor; 1 per 100 is good.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Generate the weekly CRO analysis and recommendations for this Dev.co outbound engine.

Period: past ${lookbackDays} days

DB Metrics (from outbound_prospect table):
${dbMetricsSummary}

${externalSummary ? `External metrics provided:\n${externalSummary}` : "Note: No external metrics provided. Base analysis on DB data only."}

Return exactly this JSON structure:
{
  "period": {
    "days": ${lookbackDays},
    "label": "string (e.g. 'Week of Sep 1–7, 2026')"
  },
  "playAnalysis": [
    {
      "playSlug": "DEV-01",
      "playName": "SaaS Engineering Capacity",
      "metrics": {
        "prospectsAdded": 0,
        "replied": 0,
        "replyRate": "0.0%",
        "interested": 0,
        "positiveRate": "0.0%",
        "meetings": 0
      },
      "assessment": "string (2-3 sentences — performance vs benchmark)",
      "decision": "INCREASE_VOLUME" | "CONTINUE" | "PAUSE_REANGLE" | "PAUSE",
      "decisionRationale": "string"
    }
  ],
  "nextWeekAllocation": {
    "DEV-01": 0,
    "DEV-02": 0,
    "DEV-03": 0,
    "totalDaily": 0,
    "allocationNote": "string"
  },
  "winningSignals": ["string"],
  "winningAngles": ["string"],
  "testRecommendations": [
    {
      "play": "string",
      "hypothesis": "string",
      "change": "string (what to test)",
      "priority": "HIGH" | "MEDIUM" | "LOW"
    }
  ],
  "executiveSummary": "string (3-4 sentence narrative for weekly team update)"
}`;

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
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

  output.dbMetrics = metrics;
  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};
