import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const outboundCroHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  const lookbackDays = typeof config.lookbackDays === "number" ? config.lookbackDays : 7;
  const externalMetrics = input.weeklyMetrics as Record<string, unknown> | undefined;
  const workspaceId = run.agentConfig.workspaceId;

  // Query DB for prospect metrics from the past lookbackDays
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const [plays, addedByPlay, repliedProspects, interestedProspects, meetingProspects] = await Promise.all([
    prisma.outboundPlay.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    // Grouped by playId (not just status, unlike this query before the Outbound Engine rebuild —
    // that version summed EVERY play's prospect count into each row instead of that play's own).
    prisma.outboundProspect.groupBy({
      by: ["playId"],
      where: { workspaceId, createdAt: { gte: since } },
      _count: { id: true },
    }),
    prisma.outboundProspect.findMany({
      where: { workspaceId, status: "REPLIED", updatedAt: { gte: since } },
      select: { playId: true },
    }),
    prisma.outboundProspect.findMany({
      where: { workspaceId, status: "INTERESTED", interestedAt: { gte: since } },
      select: { playId: true },
    }),
    prisma.outboundProspect.findMany({
      where: { workspaceId, status: "MEETING_BOOKED", meetingBookedAt: { gte: since } },
      select: { playId: true },
    }),
  ]);

  // Build metrics per play — every OutboundPlay this workspace actually has, not a fixed
  // three-slug list. A workspace with no plays yet gets an empty analysis, not a report about
  // plays it never created.
  const metrics = plays.map((play) => ({
    playSlug: play.slug,
    playName: play.name,
    prospectsAdded: addedByPlay.find((g) => g.playId === play.id)?._count.id ?? 0,
    replied: repliedProspects.filter((p) => p.playId === play.id).length,
    interested: interestedProspects.filter((p) => p.playId === play.id).length,
    meetings: meetingProspects.filter((p) => p.playId === play.id).length,
  }));

  const dbMetricsSummary = JSON.stringify(metrics, null, 2);
  const externalSummary = externalMetrics ? JSON.stringify(externalMetrics, null, 2) : null;

  if (plays.length === 0) {
    const output: Record<string, unknown> = {
      dbMetrics: metrics,
      executiveSummary: "No outbound plays exist for this workspace yet — nothing to analyse. Create a play on the Outbound Engine page (/outbound) and run Scout at least once first.",
      generatedAt: new Date().toISOString(),
      workspaceId,
    };
    const requireApproval = config.requireApproval !== false;
    if (requireApproval) await updateStatus("AWAITING_APPROVAL", output);
    return { output, costUsd: 0 };
  }

  const systemPrompt = `You are an outbound CRO specialist. Every Friday you review outbound performance metrics per ICP play and make data-driven recommendations.

Your job:
1. Identify which plays are performing above/below expectations
2. Surface winning signals, personas, and messaging angles
3. Recommend next week's volume allocation across this workspace's plays
4. Flag any copy or sequence changes worth testing

Benchmark expectations:
- Email reply rate: 3-5% is healthy. <2% = pause and reangle.
- Positive reply rate: >1.5% of emails sent. <0.5% = reconsider the offer angle.
- LinkedIn accept rate: 25-40% of connection requests.
- Meetings: 1 per 200 contacts is the floor; 1 per 100 is good.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Generate the weekly CRO analysis and recommendations for this workspace's outbound engine.

Period: past ${lookbackDays} days

Plays in this workspace: ${plays.map((p) => `${p.slug} (${p.name})`).join(", ")}

DB Metrics (from outbound_prospect table):
${dbMetricsSummary}

${externalSummary ? `External metrics provided:\n${externalSummary}` : "Note: No external metrics provided. Base analysis on DB data only."}

Return exactly this JSON structure — one playAnalysis entry and one nextWeekAllocation key per play listed above, using each play's own slug:
{
  "period": {
    "days": ${lookbackDays},
    "label": "string (e.g. 'Week of Sep 1–7, 2026')"
  },
  "playAnalysis": [
    {
      "playSlug": "string — one of the play slugs listed above",
      "playName": "string",
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
    "totalDaily": 0,
    "byPlay": { "playSlug": 0 },
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
    model: MODELS.standard,
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

  output.dbMetrics = metrics;
  output.generatedAt = new Date().toISOString();
  output.workspaceId = workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};
