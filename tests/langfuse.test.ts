import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isLangfuseConfigured } from "../src/integrations/langfuse.js";
import { agentFooter } from "../src/utils/comments.js";
import { getTraceUrl } from "../src/utils/tracing.js";

describe("isLangfuseConfigured", () => {
  let origPublic: string | undefined;
  let origSecret: string | undefined;
  let origBaseUrl: string | undefined;
  let origHost: string | undefined;
  let origProjectId: string | undefined;

  beforeEach(() => {
    origPublic = process.env.LANGFUSE_PUBLIC_KEY;
    origSecret = process.env.LANGFUSE_SECRET_KEY;
    origBaseUrl = process.env.LANGFUSE_BASE_URL;
    origHost = process.env.LANGFUSE_HOST;
    origProjectId = process.env.LANGFUSE_PROJECT_ID;
  });

  afterEach(() => {
    if (origPublic !== undefined) process.env.LANGFUSE_PUBLIC_KEY = origPublic;
    else process.env.LANGFUSE_PUBLIC_KEY = undefined;
    if (origSecret !== undefined) process.env.LANGFUSE_SECRET_KEY = origSecret;
    else process.env.LANGFUSE_SECRET_KEY = undefined;
    if (origBaseUrl !== undefined) process.env.LANGFUSE_BASE_URL = origBaseUrl;
    else process.env.LANGFUSE_BASE_URL = undefined;
    if (origHost !== undefined) process.env.LANGFUSE_HOST = origHost;
    else process.env.LANGFUSE_HOST = undefined;
    if (origProjectId !== undefined) process.env.LANGFUSE_PROJECT_ID = origProjectId;
    else process.env.LANGFUSE_PROJECT_ID = undefined;
  });

  it("returns false when no keys are set", () => {
    process.env.LANGFUSE_PUBLIC_KEY = undefined;
    process.env.LANGFUSE_SECRET_KEY = undefined;
    expect(isLangfuseConfigured()).toBe(false);
  });

  it("returns false when only public key is set", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk_test";
    process.env.LANGFUSE_SECRET_KEY = undefined;
    expect(isLangfuseConfigured()).toBe(false);
  });

  it("returns true when both keys are set", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk_test";
    process.env.LANGFUSE_SECRET_KEY = "sk_test";
    expect(isLangfuseConfigured()).toBe(true);
  });

  it("builds Langfuse trace URLs", () => {
    process.env.LANGFUSE_BASE_URL = "https://cloud.langfuse.com/";
    process.env.LANGFUSE_PROJECT_ID = "proj_123";

    expect(getTraceUrl("trace_456")).toBe(
      "https://cloud.langfuse.com/project/proj_123/traces/trace_456",
    );
    expect(agentFooter("trace_456")).toContain(
      "https://cloud.langfuse.com/project/proj_123/traces/trace_456",
    );
  });

  it("omits trace links when the project id is missing", () => {
    delete process.env.LANGFUSE_PROJECT_ID;
    expect(getTraceUrl("trace_456")).toBeNull();
    expect(agentFooter("trace_456")).not.toContain("trace_456");
  });
});
