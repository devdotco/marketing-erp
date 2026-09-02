import { Worker } from "bullmq";
import { prisma } from "@/lib/prisma";
import { getRedisConnection } from "@/lib/queue";
import { getHandler } from "@/lib/agent-handlers/index";

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
      } else if (freshRun?.status === "AWAITING_APPROVAL") {
        await prisma.agentRun.update({
          where: { id: runId },
          data: { costUsd, completedAt: new Date() },
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[worker] Run ${runId} failed:`, errorMsg);

      await prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          output: { error: errorMsg },
          completedAt: new Date(),
        },
      });

      throw err; // BullMQ will retry if configured
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

console.log("[worker] Agent worker started");

export default worker;
