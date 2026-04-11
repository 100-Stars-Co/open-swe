import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { getAgentStateStore, resetAgentStateStoreForTests } from "../src/state/index.js";
import { InMemoryAgentStateStore } from "../src/state/inMemoryState.js";

const state = {
  metadata: { sandboxId: "persisted-sandbox" as string | null },
  clearCalls: [] as string[],
  metadataCalls: [] as Array<{ threadId: string; metadata: Record<string, string | null> }>,
  daytonaDeletes: [] as string[],
  langsmithDeletes: [] as string[],
  daytonaError: null as Error | null,
  langsmithError: null as Error | null,
  removedJobs: [] as string[],
};

mock.module("../src/utils/sandboxState.js", () => ({
  SANDBOX_CREATING: "__creating__",
  deleteSandboxBackend: (threadId: string) => {
    state.clearCalls.push(threadId);
  },
  getSandboxBackend: () => undefined,
  getSandboxMetadata: async () => ({
    sandboxId: state.metadata.sandboxId,
    repoDir: null,
    branchName: null,
    baseBranch: null,
  }),
  setSandboxBackend: () => {},
  setSandboxMetadata: async (
    threadId: string,
    metadata: Record<string, string | null>,
  ) => {
    state.metadataCalls.push({ threadId, metadata });
    if (Object.hasOwn(metadata, "sandboxId")) {
      state.metadata.sandboxId = metadata.sandboxId === "" ? null : metadata.sandboxId;
    }
  },
  waitForSandboxId: async () => null,
}));

mock.module("../src/integrations/daytona.js", () => ({
  createDaytonaSandbox: async () => ({
    id: "stub-daytona",
    execute: async () => ({ output: "ok", exitCode: 0, truncated: false }),
  }),
  deleteDaytonaSandbox: async (sandboxId: string) => {
    state.daytonaDeletes.push(sandboxId);
    if (state.daytonaError) throw state.daytonaError;
  },
}));

mock.module("../src/integrations/langsmith.js", () => ({
  createLangsmithSandbox: async () => ({
    id: "stub-langsmith",
    execute: async () => ({ output: "ok", exitCode: 0, truncated: false }),
  }),
  deleteLangsmithSandbox: async (sandboxId: string) => {
    state.langsmithDeletes.push(sandboxId);
    if (state.langsmithError) throw state.langsmithError;
  },
}));

mock.module("../src/queue/threadQueue.js", () => ({
  enqueueThreadRun: async () => {},
  removeThreadRunJob: async (threadId: string) => {
    state.removedJobs.push(threadId);
  },
}));

const { cleanupSandboxForThread } = await import("../src/utils/sandboxLifecycle.js");
const { cleanupSandboxMiddleware } = await import("../src/middleware/cleanupSandbox.js");
const { app } = await import("../src/webapp.js");

describe("sandbox cleanup and thread deletion", () => {
  let originalSandboxType: string | undefined;

  beforeEach(async () => {
    originalSandboxType = process.env.SANDBOX_TYPE;
    state.metadata = { sandboxId: "persisted-sandbox" };
    state.clearCalls = [];
    state.metadataCalls = [];
    state.daytonaDeletes = [];
    state.langsmithDeletes = [];
    state.daytonaError = null;
    state.langsmithError = null;
    state.removedJobs = [];
    resetAgentStateStoreForTests(new InMemoryAgentStateStore());
    await getAgentStateStore().upsertThread({ threadId: "thread-8" });
    await getAgentStateStore().upsertThread({ threadId: "thread-9" });
    await getAgentStateStore().upsertThread({ threadId: "thread-10" });
  });

  afterEach(() => {
    process.env.SANDBOX_TYPE = originalSandboxType;
  });

  describe("cleanupSandboxForThread", () => {
    it("clears local sandbox state without remote deletion", async () => {
      process.env.SANDBOX_TYPE = "local";

      await cleanupSandboxForThread("thread-1");

      expect(state.clearCalls).toEqual(["thread-1"]);
      expect(state.daytonaDeletes).toEqual([]);
      expect(state.langsmithDeletes).toEqual([]);
      expect(state.metadataCalls).toEqual([{ threadId: "thread-1", metadata: { sandboxId: "" } }]);
    });

    it("deletes Daytona sandboxes and clears metadata after success", async () => {
      process.env.SANDBOX_TYPE = "daytona";

      await cleanupSandboxForThread("thread-2", "daytona-123");

      expect(state.clearCalls).toEqual(["thread-2"]);
      expect(state.daytonaDeletes).toEqual(["daytona-123"]);
      expect(state.metadataCalls).toEqual([{ threadId: "thread-2", metadata: { sandboxId: "" } }]);
    });

    it("deletes LangSmith sandboxes and clears metadata after success", async () => {
      process.env.SANDBOX_TYPE = "langsmith";

      await cleanupSandboxForThread("thread-3", "langsmith-123");

      expect(state.clearCalls).toEqual(["thread-3"]);
      expect(state.langsmithDeletes).toEqual(["langsmith-123"]);
      expect(state.metadataCalls).toEqual([{ threadId: "thread-3", metadata: { sandboxId: "" } }]);
    });

    it("preserves metadata when Daytona deletion fails", async () => {
      process.env.SANDBOX_TYPE = "daytona";
      state.daytonaError = new Error("boom");

      await expect(cleanupSandboxForThread("thread-4", "daytona-456")).rejects.toThrow("boom");

      expect(state.clearCalls).toEqual(["thread-4"]);
      expect(state.daytonaDeletes).toEqual(["daytona-456"]);
      expect(state.metadataCalls).toEqual([]);
    });
  });

  describe("cleanupSandboxMiddleware", () => {
    it("uses the shared cleanup helper", async () => {
      process.env.SANDBOX_TYPE = "daytona";

      const afterAgent = cleanupSandboxMiddleware.afterAgent as
        | ((state: Record<string, unknown>) => Promise<Record<string, unknown>>)
        | { hook: (state: Record<string, unknown>) => Promise<Record<string, unknown>> };
      const result = await ("hook" in afterAgent ? afterAgent.hook : afterAgent)({
        configurable: { thread_id: "thread-6", sandbox_id: "daytona-789" },
      });

      expect(result).toEqual({});
      expect(state.daytonaDeletes).toEqual(["daytona-789"]);
      expect(state.metadataCalls).toEqual([{ threadId: "thread-6", metadata: { sandboxId: "" } }]);
    });

    it("logs and continues when cleanup fails", async () => {
      process.env.SANDBOX_TYPE = "daytona";
      state.daytonaError = new Error("cleanup failed");
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

      const afterAgent = cleanupSandboxMiddleware.afterAgent as
        | ((state: Record<string, unknown>) => Promise<Record<string, unknown>>)
        | { hook: (state: Record<string, unknown>) => Promise<Record<string, unknown>> };
      const result = await ("hook" in afterAgent ? afterAgent.hook : afterAgent)({
        configurable: { thread_id: "thread-7", sandbox_id: "daytona-987" },
      });

      expect(result).toEqual({});
      expect(state.daytonaDeletes).toEqual(["daytona-987"]);
      expect(state.metadataCalls).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("DELETE /api/threads/:id", () => {
    it("returns success when the thread does not exist", async () => {
      const res = await app.request("/api/threads/thread-missing", { method: "DELETE" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, message: "Thread not found" });
      expect(state.daytonaDeletes).toEqual([]);
    });

    it("cleans up sandboxes before deleting the thread", async () => {
      process.env.SANDBOX_TYPE = "daytona";
      state.metadata = { sandboxId: "sandbox-123" };

      const res = await app.request("/api/threads/thread-8", { method: "DELETE" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, message: "Thread deleted" });
      expect(state.daytonaDeletes).toEqual(["sandbox-123"]);
      expect(state.removedJobs).toEqual(["thread-8"]);
      expect(await getAgentStateStore().getThread("thread-8")).toBeNull();
    });

    it("fails closed when sandbox cleanup fails", async () => {
      process.env.SANDBOX_TYPE = "daytona";
      state.metadata = { sandboxId: "sandbox-456" };
      state.daytonaError = new Error("provider teardown failed");

      const res = await app.request("/api/threads/thread-9", { method: "DELETE" });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "Failed to clean up sandbox: provider teardown failed",
        canForceDelete: true,
        cleanupFailed: true,
      });
      expect(await getAgentStateStore().getThread("thread-9")).not.toBeNull();
    });

    it("deletes the thread when force=true after sandbox cleanup fails", async () => {
      process.env.SANDBOX_TYPE = "daytona";
      state.metadata = { sandboxId: "sandbox-789" };
      state.daytonaError = new Error("provider teardown failed");

      const res = await app.request("/api/threads/thread-10?force=true", { method: "DELETE" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        message: "Thread deleted without sandbox cleanup",
      });
      expect(await getAgentStateStore().getThread("thread-10")).toBeNull();
    });
  });
});
