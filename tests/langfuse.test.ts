import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isLangfuseConfigured } from "../src/integrations/langfuse.js";

describe("isLangfuseConfigured", () => {
  let origPublic: string | undefined;
  let origSecret: string | undefined;

  beforeEach(() => {
    origPublic = process.env.LANGFUSE_PUBLIC_KEY;
    origSecret = process.env.LANGFUSE_SECRET_KEY;
  });

  afterEach(() => {
    if (origPublic !== undefined) process.env.LANGFUSE_PUBLIC_KEY = origPublic;
    else process.env.LANGFUSE_PUBLIC_KEY = undefined;
    if (origSecret !== undefined) process.env.LANGFUSE_SECRET_KEY = origSecret;
    else process.env.LANGFUSE_SECRET_KEY = undefined;
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
});
