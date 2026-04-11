import { closeThreadQueue, createThreadWorker } from "./queue/threadQueue.js";
import { ensureAgentStateStoreReady } from "./state/index.js";
import { processThreadJob } from "./workers/processThreadJob.js";

await ensureAgentStateStoreReady();

const worker = createThreadWorker(async (job) => {
  await processThreadJob(job.data.threadId);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[openswe-js] ${signal} received, shutting down worker`);
  await worker.close();
  await closeThreadQueue();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((err) => {
    console.error("[openswe-js] Worker shutdown failed:", err);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((err) => {
    console.error("[openswe-js] Worker shutdown failed:", err);
    process.exit(1);
  });
});

console.log("[openswe-js] Worker running");
