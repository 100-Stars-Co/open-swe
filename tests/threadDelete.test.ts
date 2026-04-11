import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

const state = {
  metadata: { sandboxId: "persisted-sandbox" as string | null },
  clearCalls: [] as string[],
  metadataCalls: [] as Array<{ threadId: string; metadata: Record<string, string> }>,
  daytonaDeletes: [] as string[],
  langsmithDeletes: [] as string[],
  daytonaError: null as Error | null,
  langsmithError: null as Error | null,
  threadExists: true,
  threadDeletes: [] as string[],
  runLists: [] as string[],
  runCancels: [] as Array<{ threadId: string; runId: string }>,
  operations: [] as string[],
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
  setSandboxMetadata: async (threadId: string, metadata: Record<string, string>) => {
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
    state.operations.push(`cleanup:${sandboxId}`);
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

mock.module("@langchain/langgraph-sdk", () => ({
  Client: class MockClient {
    threads = {
      get: async (threadId: string) => {
        if (!state.threadExists) throw new Error("thread not found");
        return { thread_id: threadId, status: "idle", metadata: {} };
      },
      delete: async (threadId: string) => {
        state.operations.push(`delete:${threadId}`);
        state.threadDeletes.push(threadId);
      },
    };

    runs = {
      list: async (threadId: string) => {
        state.runLists.push(threadId);
        return [
          { run_id: "run-pending", status: "pending" },
          { run_id: "run-complete", status: "success" },
        ];
      },
      cancel: async (threadId: string, runId: string) => {
        state.runCancels.push({ threadId, runId });
      },
    };
  },
}));

const { cleanupSandboxForThread } = await import("../src/utils/sandboxLifecycle.js");
const { cleanupSandboxMiddleware } = await import("../src/middleware/cleanupSandbox.js");
const { app } = await import("../src/webapp.js");

describe("sandbox cleanup and thread deletion", () => {
  let originalSandboxType: string | undefined;

  beforeEach(() => {
    originalSandboxType = process.env.SANDBOX_TYPE;
    state.metadata = { sandboxId: "persisted-sandbox" };
    state.clearCalls = [];
    state.metadataCalls = [];
    state.daytonaDeletes = [];
    state.langsmithDeletes = [];
    state.daytonaError = null;
    state.langsmithError = null;
    state.threadExists = true;
    state.threadDeletes = [];
    state.runLists = [];
    state.runCancels = [];
    state.operations = [];
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
      expect(state.metadata.sandboxId).toBe("persisted-sandbox");
    });

    it("fails for unsupported remote providers without clearing metadata", async () => {
      process.env.SANDBOX_TYPE = "e2b";

      await expect(cleanupSandboxForThread("thread-5", "e2b-123")).rejects.toThrow(
        "Sandbox cleanup is not supported for provider 'e2b'",
      );

      expect(state.clearCalls).toEqual(["thread-5"]);
      expect(state.metadataCalls).toEqual([]);
    });
  });

  describe("cleanupSandboxMiddleware", () => {
    it("uses the shared cleanup helper", async () => {
      process.env.SANDBOX_TYPE = "daytona";

      const result = await cleanupSandboxMiddleware.afterAgent?.({
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

      const result = await cleanupSandboxMiddleware.afterAgent?.({
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
      state.threadExists = false;

      const res = await app.request("/api/threads/thread-missing", { method: "DELETE" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, message: "Thread not found" });
      expect(state.threadDeletes).toEqual([]);
      expect(state.daytonaDeletes).toEqual([]);
    });

    it("cleans up sandboxes before deleting the thread", async () => {
      process.env.SANDBOX_TYPE = "daytona";
      state.metadata = { sandboxId: "sandbox-123" };

      const res = await app.request("/api/threads/thread-8", { method: "DELETE" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, message: "Thread deleted" });
      expect(state.runLists).toEqual(["thread-8"]);
      expect(state.runCancels).toEqual([{ threadId: "thread-8", runId: "run-pending" }]);
      expect(state.daytonaDeletes).toEqual(["sandbox-123"]);
      expect(state.threadDeletes).toEqual(["thread-8"]);
      expect(state.operations).toEqual(["cleanup:sandbox-123", "delete:thread-8"]);
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
      expect(state.daytonaDeletes).toEqual(["sandbox-456"]);
      expect(state.threadDeletes).toEqual([]);
      expect(state.operations).toEqual(["cleanup:sandbox-456"]);
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
      expect(state.daytonaDeletes).toEqual(["sandbox-789"]);
      expect(state.threadDeletes).toEqual(["thread-10"]);
      expect(state.operations).toEqual(["cleanup:sandbox-789", "delete:thread-10"]);
    });
  });
});
