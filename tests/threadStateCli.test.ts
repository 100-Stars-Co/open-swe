import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const state = {
  threadStatus: "busy" as "busy" | "idle" | "interrupted" | "error" | "missing",
  clientConfigs: [] as Array<{ apiUrl?: string } | undefined>,
};

mock.module("@langchain/langgraph-sdk", () => ({
  Client: class MockClient {
    threads = {
      get: async (threadId: string) => {
        if (state.threadStatus === "missing") {
          const err = new Error(`HTTP 404: thread ${threadId} not found`) as Error & {
            status?: number;
          };
          err.status = 404;
          throw err;
        }

        return {
          thread_id: threadId,
          status: state.threadStatus,
        };
      },
    };

    constructor(config?: { apiUrl?: string }) {
      state.clientConfigs.push(config);
    }
  },
}));

const { formatThreadState, runThreadStateCli } = await import("../src/cli/threadState.js");

describe("thread state cli", () => {
  beforeEach(() => {
    state.threadStatus = "busy";
    state.clientConfigs = [];
    process.env.LANGGRAPH_API_URL = "http://langgraph.example.test:8123";
  });

  afterEach(() => {
    delete process.env.LANGGRAPH_API_URL;
  });

  it("formats busy threads", () => {
    expect(formatThreadState({ threadId: "abc", status: "busy" })).toBe("Thread abc: busy");
  });

  it("reports idle threads as not busy", async () => {
    state.threadStatus = "idle";
    const output: string[] = [];
    const exitCode = await runThreadStateCli(["thread-1"], {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(`ERR:${line}`),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual(["Thread thread-1: not busy (idle)"]);
    expect(state.clientConfigs).toEqual([{ apiUrl: "http://langgraph.example.test:8123" }]);
  });

  it("reports missing threads", async () => {
    state.threadStatus = "missing";
    const output: string[] = [];
    const exitCode = await runThreadStateCli(["missing-thread"], {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(`ERR:${line}`),
    });

    expect(exitCode).toBe(2);
    expect(output).toEqual(["Thread missing-thread: missing"]);
  });

  it("shows usage when no thread id is provided", async () => {
    const output: string[] = [];
    const exitCode = await runThreadStateCli([], {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(`ERR:${line}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual(["ERR:Usage: bun run thread:state <thread-id>"]);
  });
});
