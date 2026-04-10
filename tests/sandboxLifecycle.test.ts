import { describe, expect, it, mock } from "bun:test";

const state = {
  backendCache: new Map<string, unknown>(),
  createCalls: [] as Array<{ sandboxId?: string }>,
  executeCalls: [] as string[],
  metadataCalls: [] as Array<{ threadId: string; metadata: Record<string, string> }>,
  clearCalls: [] as string[],
  metadata: { sandboxId: "dead-sandbox" as string | null },
};

mock.module("../src/utils/sandbox.js", () => ({
  createSandbox: async (sandboxId?: string) => {
    state.createCalls.push({ sandboxId });

    if (sandboxId === "dead-sandbox") {
      throw new Error("SandboxApiException: Sandbox dead-sandbox not found.");
    }

    return {
      id: sandboxId ?? "fresh-sandbox",
      execute: async (command: string) => {
        state.executeCalls.push(command);
        return { output: "ok", exitCode: 0, truncated: false };
      },
    };
  },
}));

mock.module("../src/utils/sandboxState.js", () => ({
  SANDBOX_CREATING: "__creating__",
  getSandboxBackend: (threadId: string) => state.backendCache.get(threadId),
  setSandboxBackend: (threadId: string, backend: unknown) => {
    state.backendCache.set(threadId, backend);
  },
  deleteSandboxBackend: (threadId: string) => {
    state.clearCalls.push(threadId);
    state.backendCache.delete(threadId);
  },
  getSandboxMetadata: async (_threadId: string) => ({
    sandboxId: state.metadata.sandboxId,
    repoDir: null,
    branchName: null,
    baseBranch: null,
  }),
  setSandboxMetadata: async (threadId: string, metadata: Record<string, string>) => {
    state.metadataCalls.push({ threadId, metadata });
    if (Object.hasOwn(metadata, "sandboxId")) {
      state.metadata.sandboxId = metadata.sandboxId === "" ? null : metadata.sandboxId;
    }
  },
  waitForSandboxId: async () => null,
}));

const { getOrCreateSandbox } = await import("../src/utils/sandboxLifecycle.js");

describe("getOrCreateSandbox", () => {
  it("recreates a sandbox when the persisted sandbox id no longer exists", async () => {
    const sandbox = await getOrCreateSandbox("thread-1");

    expect(sandbox.id).toBe("fresh-sandbox");
    expect(state.createCalls).toEqual([
      { sandboxId: "dead-sandbox" },
      { sandboxId: undefined },
    ]);
    expect(state.clearCalls).toEqual(["thread-1"]);
    expect(state.executeCalls).toEqual(["echo ok"]);
    expect(state.metadataCalls).toEqual([
      { threadId: "thread-1", metadata: { sandboxId: "" } },
      { threadId: "thread-1", metadata: { sandboxId: "__creating__" } },
      { threadId: "thread-1", metadata: { sandboxId: "fresh-sandbox" } },
    ]);
  });
});
