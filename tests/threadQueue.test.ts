import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

type FakeState = "waiting" | "active" | "completed" | "failed" | "unknown";

const state = {
  addedJobs: [] as Array<{ name: string; data: { threadId: string }; opts: { jobId: string } }>,
  jobs: new Map<
    string,
    {
      state: FakeState;
      removed: boolean;
      getState: () => Promise<FakeState>;
      remove: () => Promise<void>;
    }
  >(),
};

class FakeQueue {
  async add(name: string, data: { threadId: string }, opts: { jobId: string }) {
    state.addedJobs.push({ name, data, opts });
    return { id: opts.jobId };
  }

  async getJob(jobId: string) {
    return state.jobs.get(jobId) ?? null;
  }

  async close() {}
}

class FakeWorker {
  constructor() {}
}

class FakeIORedis {
  async quit() {}
}

mock.module("bullmq", () => ({
  Queue: FakeQueue,
  Worker: FakeWorker,
}));

mock.module("ioredis", () => ({
  default: FakeIORedis,
}));

const { closeThreadQueue, enqueueThreadRun } = await import("../src/queue/threadQueue.js");

function resetState(): void {
  state.addedJobs = [];
  state.jobs = new Map();
}

function setExistingJob(jobId: string, jobState: FakeState): void {
  state.jobs.set(jobId, {
    state: jobState,
    removed: false,
    getState: async () => jobState,
    remove: async () => {
      state.jobs.delete(jobId);
    },
  });
}

describe("thread queue deduplication", () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(async () => {
    await closeThreadQueue();
    resetState();
  });

  it("does not enqueue a duplicate job while a thread run is still active", async () => {
    setExistingJob("thread-1", "active");

    await enqueueThreadRun("thread-1");

    expect(state.addedJobs).toHaveLength(0);
  });

  it("re-enqueues a thread after its previous job completed", async () => {
    setExistingJob("thread-2", "completed");

    await enqueueThreadRun("thread-2");

    expect(state.addedJobs).toEqual([
      {
        name: "process-thread",
        data: { threadId: "thread-2" },
        opts: { jobId: "thread-2" },
      },
    ]);
    expect(state.jobs.has("thread-2")).toBe(false);
  });
});
