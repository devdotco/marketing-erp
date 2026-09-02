import { Queue } from "bullmq";
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

// Singleton connection
let connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return connection;
}

// Singleton queue
let agentRunQueue: Queue | null = null;

export function getAgentRunQueue(): Queue {
  if (!agentRunQueue) {
    agentRunQueue = new Queue("agent-runs", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
      },
    });
  }
  return agentRunQueue;
}

export async function enqueueAgentRun(runId: string): Promise<void> {
  const queue = getAgentRunQueue();
  await queue.add("run", { runId }, { jobId: runId });
}
