import { prisma } from "@/lib/prisma";
import { enqueueAgentRun } from "@/lib/queue";

export interface CreateAgentRunParams {
  workspaceId: string;
  agentConfigId: string;
  /** Whatever the caller has to hand off. resolveInputs (lib/agents/inputs.ts)
   *  falls back to AgentConfig.config for anything missing here, so an empty
   *  object is a perfectly normal input — that's what a scheduled run passes. */
  input?: Record<string, unknown>;
  /** A user id for a person-triggered run, `"schedule"` for the schedule
   *  runner (lib/scheduler.ts), or a `webhook:<vendor>` string — see the
   *  RunStatus/triggeredBy convention already used across app/api/runs and
   *  lib/webhooks/receive.ts. */
  triggeredBy: string | null;
}

/**
 * Create an AgentRun row and enqueue it on the BullMQ agent-runs queue.
 *
 * Pulled out of app/api/runs/route.ts's POST handler so "Run now" and the
 * schedule runner (lib/scheduler.ts) create work exactly the same way — same
 * queue, same job options, same "an enqueue failure leaves the run PENDING
 * instead of failing the caller" behavior. Everything that decides WHETHER a
 * run is allowed (an enabled AgentConfig, workspace access, a schedule that's
 * actually due) is the caller's job to check first: this function only ever
 * writes the row and enqueues it.
 */
export async function createAgentRun({
  workspaceId,
  agentConfigId,
  input,
  triggeredBy,
}: CreateAgentRunParams): Promise<{ id: string }> {
  const run = await prisma.agentRun.create({
    data: {
      workspaceId,
      agentConfigId,
      input: (input ?? {}) as object,
      status: "PENDING",
      triggeredBy,
    },
  });

  try {
    await enqueueAgentRun(run.id);
  } catch (err) {
    // Queue failure shouldn't block the caller — run stays PENDING and can be retried.
    console.error(`Failed to enqueue agent run ${run.id}:`, err);
  }

  return run;
}
