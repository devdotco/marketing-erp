import { Worker, UnrecoverableError } from "bullmq";
import { prisma } from "@/lib/prisma";
import { getRedisConnection } from "@/lib/queue";
import { getHandler } from "@/lib/agent-handlers/index";
import { runOutboundChaining } from "@/lib/agent-handlers/chaining";
import { describeRunError } from "@/lib/ai/errors";
import { checkModelsAvailable } from "@/lib/ai/models";
import { startScheduler } from "@/lib/scheduler";

const worker = new Worker(
  "agent-runs",
  async (job) => {
    const runId = job.data.runId as string;

    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: { agentConfig: true },
    });

    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    if (run.status === "COMPLETED" || run.status === "FAILED") {
      return; // idempotent
    }

    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    const updateStatus = async (status: string, output?: Record<string, unknown>) => {
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: status as never, ...(output ? { output: output as object } : {}) },
      });
    };

    const handler = getHandler(run.agentConfig.agentSlug);

    try {
      const { output, costUsd } = await handler(run as Parameters<typeof handler>[0], updateStatus);

      // Only mark COMPLETED if not AWAITING_APPROVAL (handler may have set that)
      const freshRun = await prisma.agentRun.findUnique({ where: { id: runId } });
      if (freshRun?.status === "RUNNING") {
        await prisma.agentRun.update({
          where: { id: runId },
          data: {
            status: "COMPLETED",
            output: output as object,
            costUsd,
            completedAt: new Date(),
          },
        });

        // Outbound Engine pipeline chaining (Scout -> Strategist -> Email/LinkedIn Outbound) —
        // no-ops for every other agent slug. Only reached here for a Scout run that did NOT await
        // approval (requireApproval off); the approval path is handled from
        // app/api/runs/[runId]/approve/route.ts instead, since this branch never runs for a run
        // sitting in AWAITING_APPROVAL. Strategist never awaits approval, so it always chains here.
        await runOutboundChaining({ ...run, status: "COMPLETED", output: output as object }).catch((err) =>
          console.error(`[worker] run ${runId}: outbound chaining failed:`, err),
        );
      } else if (freshRun?.status === "AWAITING_APPROVAL") {
        await prisma.agentRun.update({
          where: { id: runId },
          data: { costUsd, completedAt: new Date() },
        });
      }
    } catch (err) {
      const runError = describeRunError(err);
      const attemptsMade = job.attemptsMade + 1;
      const attemptsAllowed = job.opts.attempts ?? 1;
      const willRetry = runError.retryable && attemptsMade < attemptsAllowed;

      console.error(
        `[worker] Run ${runId} failed (${runError.code}, attempt ${attemptsMade}/${attemptsAllowed}${willRetry ? ", will retry" : ""}):`,
        runError.detail ?? runError.message
      );

      if (willRetry) {
        // Leave the run RUNNING — a retry is queued and will finish it.
        throw err;
      }

      await prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          output: {
            error: {
              code: runError.code,
              message: runError.message,
              hint: runError.hint,
              retryable: runError.retryable,
              attempts: attemptsMade,
              detail: runError.detail,
              failedAt: new Date().toISOString(),
            },
          },
          completedAt: new Date(),
        },
      });

      // A stale model id or a bad key will fail identically on every retry —
      // burning attempts on it only delays the error reaching the user.
      if (!runError.retryable) {
        throw new UnrecoverableError(`${runError.code}: ${runError.message}`);
      }
      throw err;
    }
  },
  {
    connection: getRedisConnection(),
    concurrency: 5,
  }
);

worker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

// Pre-flight: fail loudly at boot rather than at the first API call of a run.
// The 2026-09-08 Blog Writer failure was a stale model snapshot that nothing
// checked until a user pressed "Run now".
void checkModelsAvailable(true)
  .then((health) => {
    for (const model of health.models) {
      if (!model.ok) {
        console.error(`[worker] MODEL UNAVAILABLE: ${model.id} — ${model.error}`);
      }
    }
    if (health.ok) {
      console.log(`[worker] Models OK: ${health.models.map((m) => m.id).join(", ")}`);
    } else {
      console.error("[worker] One or more configured models are unavailable. Agent runs using them WILL fail.");
    }
  })
  .catch((err) => {
    console.error("[worker] Could not verify model availability:", err instanceof Error ? err.message : err);
  });

console.log("[worker] Agent worker started");

// Same process as the BullMQ consumer above — see lib/scheduler.ts for why:
// start.sh runs exactly one worker process per container, so this is the one
// place a minute-aligned poll needs to live for every AgentConfig with a
// schedule to actually fire, across every environment this app deploys to.
startScheduler();

export default worker;
