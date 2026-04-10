import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const state = {
  createCalls: [] as Array<{
    params: Record<string, unknown>;
    options: { timeout?: number } | undefined;
  }>,
};

mock.module("@daytona/sdk", () => ({
  Daytona: class MockDaytona {
    async create(params: Record<string, unknown>, options?: { timeout?: number }) {
      state.createCalls.push({ params, options });
      return { id: "sandbox-123", state: "started" };
    }

    async get() {
      return { id: "sandbox-123", state: "started" };
    }

    async start() {
      return undefined;
    }

    async delete() {
      return undefined;
    }
  },
}));

const { createDaytonaSandbox } = await import("../src/integrations/daytona.js");

const ORIGINAL_ENV = {
  DAYTONA_SNAPSHOT: process.env.DAYTONA_SNAPSHOT,
  DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
  DAYTONA_API_URL: process.env.DAYTONA_API_URL,
  DAYTONA_TARGET: process.env.DAYTONA_TARGET,
  SANDBOX_TIMEOUT: process.env.SANDBOX_TIMEOUT,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

function restoreEnv(): void {
  process.env.DAYTONA_SNAPSHOT = ORIGINAL_ENV.DAYTONA_SNAPSHOT;
  process.env.DAYTONA_API_KEY = ORIGINAL_ENV.DAYTONA_API_KEY;
  process.env.DAYTONA_API_URL = ORIGINAL_ENV.DAYTONA_API_URL;
  process.env.DAYTONA_TARGET = ORIGINAL_ENV.DAYTONA_TARGET;
  process.env.SANDBOX_TIMEOUT = ORIGINAL_ENV.SANDBOX_TIMEOUT;
  process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV.ANTHROPIC_API_KEY;
}

describe("createDaytonaSandbox", () => {
  beforeEach(() => {
    state.createCalls = [];
    process.env.DAYTONA_SNAPSHOT = undefined;
    process.env.DAYTONA_API_KEY = undefined;
    process.env.DAYTONA_API_URL = undefined;
    process.env.DAYTONA_TARGET = undefined;
    process.env.SANDBOX_TIMEOUT = undefined;
    process.env.ANTHROPIC_API_KEY = undefined;
  });

  afterEach(() => {
    restoreEnv();
  });

  it("defaults to the daytona-medium snapshot", async () => {
    await createDaytonaSandbox();

    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0]?.params.snapshot).toBe("daytona-medium");
  });

  it("uses DAYTONA_SNAPSHOT when configured", async () => {
    process.env.DAYTONA_SNAPSHOT = "daytona-medium-v2";

    await createDaytonaSandbox();

    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0]?.params.snapshot).toBe("daytona-medium-v2");
  });
});
