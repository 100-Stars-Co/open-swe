import { beforeEach, describe, expect, it } from "bun:test";
import { resetAgentStateStoreForTests, getAgentStateStore } from "../src/state/index.js";
import { InMemoryAgentStateStore } from "../src/state/inMemoryState.js";

const { formatThreadState, runThreadStateCli } = await import("../src/cli/threadState.js");

describe("thread state cli", () => {
  beforeEach(() => {
    resetAgentStateStoreForTests(new InMemoryAgentStateStore());
  });

  it("formats busy threads", () => {
    expect(formatThreadState({ threadId: "abc", status: "busy" })).toBe("Thread abc: busy");
  });

  it("reports idle threads as not busy", async () => {
    await getAgentStateStore().upsertThread({ threadId: "thread-1", status: "idle" });
    const output: string[] = [];
    const exitCode = await runThreadStateCli(["thread-1"], {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(`ERR:${line}`),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual(["Thread thread-1: not busy (idle)"]);
  });

  it("reports missing threads", async () => {
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
