/**
 * The schedule runner: turns `AgentConfig.schedule` + `AgentConfig.enabled`
 * into actual runs, on its own, without a person pressing "Run now".
 *
 * Before this existed those two columns were write-only — lib/agents.ts
 * advertised cadences ("Daily", "every Friday") that nothing ever enforced,
 * so an Outbound Engine campaign only ever advanced when someone remembered
 * to click the button.
 *
 * Where it runs: inside the same worker process that already runs the BullMQ
 * job consumer (workers/agent-worker.ts calls startScheduler() once at
 * import time). start.sh starts exactly that process (`node worker.js &`)
 * alongside `next start` in every environment this app deploys to — see the
 * Dockerfile/start.sh — so there is nothing extra to schedule in Coolify. A
 * setInterval aligned to the minute boundary polls AgentConfig for due rows;
 * no external cron, no separate container.
 *
 * Idempotency across multiple containers/restarts, without a schema change:
 * a Redis `SET NX EX` lock keyed on (configId, minute-slot), using the same
 * ioredis connection lib/queue.ts already opens for BullMQ. This was chosen
 * over the other two options sketched in the task:
 *   - A BullMQ repeatable job / job scheduler per AgentConfig would need its
 *     own reconciliation loop to stay in sync with every enable/disable and
 *     schedule edit (create on enable, remove on disable, survive a Redis
 *     flush) — more moving parts than the polling loop the task asked for.
 *   - Checking for an existing AgentRun row created in the slot works but
 *     needs a query with a time-range WHERE per config per tick; the Redis
 *     lock is one round-trip, self-expiring (so a crash mid-run never wedges
 *     a slot open), and needs no new index.
 * The AgentRun existence check (via `triggeredBy: "schedule"`) is still used
 * below, but for a different job: not cross-container dedup (Redis owns
 * that), but the "don't pile up on top of an unapproved run" rule — see
 * evaluateOne.
 */
import type { AgentConfig } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRedisConnection } from "@/lib/queue";
import { createAgentRun } from "@/lib/agents/create-run";
import { parseCron, matchesCron, slotKeyFor } from "@/lib/cron";

const LOCK_TTL_SECONDS = 120; // comfortably longer than the 60s tick, so a slow tick can't race its own lock
const POLL_INTERVAL_MS = 60_000;

/**
 * Evaluate every enabled, scheduled AgentConfig against `now` (defaults to
 * the real clock) and enqueue a run for each one due at this minute that
 * isn't already claimed or already in flight. Exported standalone (not just
 * via startScheduler) so it can be driven directly — by a test, or by hand
 * from a one-off script — without waiting on a timer.
 */
export async function runDueSchedules(now: Date = new Date()): Promise<void> {
  const slot = new Date(now);
  slot.setUTCSeconds(0, 0);

  const configs = await prisma.agentConfig.findMany({
    where: { enabled: true, schedule: { not: null } },
  });

  for (const config of configs) {
    await evaluateOne(config, slot).catch((err) => {
      console.error(`[scheduler] config ${config.id} (${config.agentSlug}) failed:`, err);
    });
  }
}

async function evaluateOne(config: AgentConfig, slot: Date): Promise<void> {
  if (!config.schedule) return; // narrows the type; the query above already filters this

  let cron;
  try {
    cron = parseCron(config.schedule);
  } catch (err) {
    console.error(
      `[scheduler] config ${config.id} (${config.agentSlug}) has an invalid schedule "${config.schedule}", skipping:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (!matchesCron(cron, slot)) return;

  // Cross-container/restart dedup for this exact (config, slot). The first
  // container to reach this line wins; every other container's poll for the
  // same minute — a second replica, a redeploy overlap — sees the key
  // already set and returns immediately. Self-expiring via EX, so this can
  // never leave a slot permanently locked if a container dies mid-tick.
  const redis = getRedisConnection();
  const lockKey = `sched-lock:${config.id}:${slotKeyFor(slot)}`;
  const acquired = await redis.set(lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX");
  if (acquired !== "OK") return;

  // Don't pile up on top of a run still waiting for approval or still going.
  // This matters most for Outbound Scout: requireApproval defaults to true,
  // so a workspace that doesn't review daily would otherwise accumulate one
  // AWAITING_APPROVAL Scout run per missed day instead of one that just waits.
  const inFlight = await prisma.agentRun.findFirst({
    where: {
      agentConfigId: config.id,
      triggeredBy: "schedule",
      status: { in: ["PENDING", "RUNNING", "AWAITING_APPROVAL"] },
    },
    select: { id: true, status: true },
    orderBy: { createdAt: "desc" },
  });
  if (inFlight) {
    console.log(
      `[scheduler] config ${config.id} (${config.agentSlug}) due at ${slot.toISOString()} — skipped, ` +
        `previous scheduled run ${inFlight.id} is still ${inFlight.status}`,
    );
    return;
  }

  // Empty input is deliberate: resolveInputs (lib/agents/inputs.ts) already
  // falls back to AgentConfig.config for anything a run doesn't supply, which
  // is exactly the saved-defaults behavior a schedule should get — the same
  // path a person gets by pressing "Run now" without touching any field.
  const run = await createAgentRun({
    workspaceId: config.workspaceId,
    agentConfigId: config.id,
    input: {},
    triggeredBy: "schedule",
  });

  console.log(`[scheduler] config ${config.id} (${config.agentSlug}) due at ${slot.toISOString()} — enqueued run ${run.id}`);
}

let started = false;

/**
 * Wire runDueSchedules to a minute-aligned timer. Idempotent — a second call
 * (there is only one call site, workers/agent-worker.ts, but defensive
 * against a future accidental double-import) is a no-op rather than a second
 * competing timer.
 */
export function startScheduler(): void {
  if (started) return;
  started = true;

  const alignDelayMs = POLL_INTERVAL_MS - (Date.now() % POLL_INTERVAL_MS);

  const tick = () => {
    void runDueSchedules().catch((err) => console.error("[scheduler] tick failed:", err));
  };

  setTimeout(() => {
    tick();
    setInterval(tick, POLL_INTERVAL_MS);
  }, alignDelayMs);

  console.log(`[scheduler] started, first tick in ${alignDelayMs}ms`);
}
