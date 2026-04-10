import { afterEach, describe, expect, it } from "bun:test";
import { getSandboxRepoRoot, resolveSandboxRepoDir } from "../src/utils/repoDir.js";

const ORIGINAL_SANDBOX_REPO_ROOT = process.env.SANDBOX_REPO_ROOT;

afterEach(() => {
  if (ORIGINAL_SANDBOX_REPO_ROOT === undefined) {
    delete process.env.SANDBOX_REPO_ROOT;
    return;
  }
  process.env.SANDBOX_REPO_ROOT = ORIGINAL_SANDBOX_REPO_ROOT;
});

describe("repo dir resolution", () => {
  it("defaults to /tmp/repos", () => {
    delete process.env.SANDBOX_REPO_ROOT;

    expect(getSandboxRepoRoot()).toBe("/tmp/repos");
    expect(resolveSandboxRepoDir("my-org", "my-repo")).toBe("/tmp/repos/my-org/my-repo");
  });

  it("uses SANDBOX_REPO_ROOT when set", () => {
    process.env.SANDBOX_REPO_ROOT = "/workspace/repos/";

    expect(getSandboxRepoRoot()).toBe("/workspace/repos");
    expect(resolveSandboxRepoDir("my-org", "my-repo")).toBe("/workspace/repos/my-org/my-repo");
  });

  it("sanitizes owner and repo segments", () => {
    delete process.env.SANDBOX_REPO_ROOT;

    expect(resolveSandboxRepoDir("100 Stars Co", "goal/tracking agent")).toBe(
      "/tmp/repos/100-Stars-Co/goal-tracking-agent",
    );
  });
});
