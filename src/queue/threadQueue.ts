import { Queue, Worker, type JobsOptions } from "bullmq";
import type { Processor } from "bullmq";
import IORedis from "ioredis";

export interface ThreadJobData {
  threadId: string;
}

const THREAD_QUEUE_NAME = "openswe-thread-runs";

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 1000,
  },
  removeOnComplete: 100,
  removeOnFail: 100,
};

let queue: Queue<ThreadJobData> | null = null;
let queueConnection: IORedis | null = null;

function getRedisConnection(): IORedis {
  if (!queueConnection) {
    queueConnection = new IORedis({
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number.parseInt(process.env.REDIS_QUEUE_DB ?? "1", 10),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return queueConnection;
}

export function getThreadQueue(): Queue<ThreadJobData> {
  if (!queue) {
    queue = new Queue<ThreadJobData>(THREAD_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions,
    });
  }
  return queue;
}

function isTerminalJobState(state: string): boolean {
  return state === "completed" || state === "failed" || state === "unknown";
}

export async function enqueueThreadRun(threadId: string): Promise<void> {
  const threadQueue = getThreadQueue();
  const existingJob = await threadQueue.getJob(threadId);

  if (existingJob) {
    const existingState = await existingJob.getState();

    if (!isTerminalJobState(existingState)) {
      return;
    }

    await existingJob.remove();
  }

  await threadQueue.add(
    "process-thread",
    { threadId },
    {
      jobId: threadId,
    },
  );
}

export async function removeThreadRunJob(threadId: string): Promise<void> {
  const job = await getThreadQueue().getJob(threadId);
  if (job) {
    await job.remove();
  }
}

export function createThreadWorker(processor: Processor<ThreadJobData>): Worker<ThreadJobData> {
  return new Worker<ThreadJobData>(THREAD_QUEUE_NAME, processor, {
    connection: getRedisConnection(),
    concurrency: 5,
  });
}

export async function closeThreadQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }

  if (queueConnection) {
    await queueConnection.quit();
    queueConnection = null;
  }
}
