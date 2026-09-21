/**
 * Daily capital-raise tick.
 *
 * Once a day, for every play across every workspace that has capital-raise sourcing and its daily
 * tick turned on, enqueue an Outbound Scout run in SEC Form D mode. That is all this route does:
 * it creates PENDING AgentRuns and hands them to the normal queue, so the sourcing, the play's
 * filters, the approval gate and the Scout → Strategist chaining are the same code paths a
 * hand-triggered run goes through. Nothing here talks to EDGAR or Apollo, and nothing here sends
 * anything to a prospect.
 *
 * Driven by an external timer POSTing with the shared cron secret, same as
 * app/api/cron/social-publish and social-auto-post. Suggested unit (once daily, on a weekday
 * morning — EDGAR posts the previous day's filings overnight and files nothing at weekends):
 *
 *   curl -fsS -X POST https://marketing.erp.io/api/cron/outbound-form-d \
 *        -H "x-cron-secret: $CRON_SECRET"
 *
 * Safe to fire more than once a day: a play that already has a capital-raise Scout run inside the
 * dedupe window below is skipped rather than sourced (and billed) twice.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { constantTimeEqual } from "@/lib/security/compare";
import { enqueueAgentRun } from "@/lib/queue";
import { parsePlayConfig, planFormDDailyTick, type FormDTickPlay } from "@/lib/agent-handlers/outbound-play-config";

export const dynamic = "force-dynamic";

const SCOUT_SLUG = "outbound-scout";

/** How far back to look for an existing capital-raise run before enqueueing another. 20 hours,
 * not 24: a timer that drifts a little earlier each day (or runs after a late catch-up) should
 * still get its daily run, while a double-fire minutes apart is caught. */
const DEDUPE_WINDOW_HOURS = 20;

export async function POST(req: NextRequest) {
  // Constant time, and an unset CRON_SECRET matches nothing.
  if (!constantTimeEqual(req.headers.get("x-cron-secret"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional narrowing, for a manual kick or a staged rollout: ?workspaceId=xxx&playSlugs=a,b
  const { searchParams } = req.nextUrl;
  const workspaceIdParam = searchParams.get("workspaceId");
  const playSlugsParam = searchParams.get("playSlugs");
  const allowedSlugs = playSlugsParam ? new Set(playSlugsParam.split(",").map((s) => s.trim()).filter(Boolean)) : null;

  const plays = await prisma.outboundPlay.findMany({
    where: workspaceIdParam ? { workspaceId: workspaceIdParam } : {},
    select: { id: true, workspaceId: true, slug: true, name: true, enabled: true, config: true },
  });

  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 60 * 60 * 1000);

  // Group by workspace — the dedupe lookup and the Scout AgentConfig are both per-workspace, so
  // doing this once per workspace beats once per play.
  const byWorkspace = new Map<string, typeof plays>();
  for (const play of plays) {
    if (allowedSlugs && !allowedSlugs.has(play.slug)) continue;
    const list = byWorkspace.get(play.workspaceId) ?? [];
    list.push(play);
    byWorkspace.set(play.workspaceId, list);
  }

  const enqueued: Array<{ workspaceId: string; playSlug: string; runId: string }> = [];
  const skipped: Array<{ workspaceId: string; playSlug: string; reason: string }> = [];

  for (const [workspaceId, workspacePlays] of byWorkspace) {
    const scoutConfig = await prisma.agentConfig.findUnique({
      where: { workspaceId_agentSlug: { workspaceId, agentSlug: SCOUT_SLUG } },
    });
    if (!scoutConfig || !scoutConfig.enabled) {
      for (const play of workspacePlays) {
        skipped.push({ workspaceId, playSlug: play.slug, reason: "scout_agent_not_enabled" });
      }
      continue;
    }

    // Which plays already had a capital-raise run inside the window. Read back and filtered in
    // JS rather than as a Prisma JSON-path predicate: the volume is a handful of rows per
    // workspace per day, and `input` is written by several callers (the Run modal, chaining,
    // this route) whose shapes only agree on these two keys.
    const recentRuns = await prisma.agentRun.findMany({
      where: { workspaceId, agentConfigId: scoutConfig.id, createdAt: { gte: since } },
      select: { input: true },
    });
    const recentlyRanSlugs = new Set<string>();
    for (const run of recentRuns) {
      const input = (run.input ?? {}) as Record<string, unknown>;
      if (input.sourcingMode === "capital_raise" && typeof input.playSlug === "string") {
        recentlyRanSlugs.add(input.playSlug);
      }
    }

    const tickPlays: FormDTickPlay[] = workspacePlays.map((play) => ({
      slug: play.slug,
      name: play.name,
      enabled: play.enabled,
      config: parsePlayConfig(play.config),
    }));

    const plan = planFormDDailyTick(tickPlays, recentlyRanSlugs);

    for (const skip of plan.skipped) {
      skipped.push({ workspaceId, playSlug: skip.playSlug, reason: skip.reason });
    }

    for (const due of plan.due) {
      try {
        const run = await prisma.agentRun.create({
          data: {
            workspaceId,
            agentConfigId: scoutConfig.id,
            input: {
              playSlug: due.playSlug,
              // The internal key, not the Run modal's label — parseSourcingMode accepts either,
              // and this is also what the dedupe above matches on.
              sourcingMode: "capital_raise",
              maxProspects: due.maxProspects,
            },
            status: "PENDING",
            triggeredBy: "cron:outbound-form-d",
          },
        });
        await enqueueAgentRun(run.id).catch((err) =>
          console.error(`[cron/outbound-form-d] failed to enqueue run ${run.id} for play ${due.playSlug}:`, err),
        );
        enqueued.push({ workspaceId, playSlug: due.playSlug, runId: run.id });
      } catch (err) {
        // One play's failure must not cost every other workspace its daily tick.
        console.error(`[cron/outbound-form-d] failed to create run for play ${due.playSlug}:`, err);
        skipped.push({ workspaceId, playSlug: due.playSlug, reason: "run_create_failed" });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    enqueued: enqueued.length,
    runs: enqueued,
    skipped,
    dedupeWindowHours: DEDUPE_WINDOW_HOURS,
  });
}

/** Unauthenticated liveness probe — says whether the route is wired and how many plays currently
 * have the daily tick on, without revealing which workspaces they belong to. */
export async function GET() {
  const plays = await prisma.outboundPlay.findMany({ select: { enabled: true, config: true } });
  const armed = plays.filter((p) => {
    const config = parsePlayConfig(p.config);
    return p.enabled && config.capitalRaise.enabled && config.capitalRaise.dailyTick;
  }).length;
  return NextResponse.json({ ok: true, playsWithDailyTick: armed });
}
