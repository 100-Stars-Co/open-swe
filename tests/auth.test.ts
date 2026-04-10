import { afterEach, describe, expect, it } from "bun:test";
import {
  getGithubTokenFromEnv,
  isEphemeralGithubToken,
  shouldPersistGithubToken,
} from "../src/utils/auth.js";

const ORIGINAL_ENV = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_PAT: process.env.GITHUB_PAT,
  GH_TOKEN: process.env.GH_TOKEN,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
});

describe("github auth helpers", () => {
  it("prefers GITHUB_TOKEN over other env tokens", () => {
    process.env.GITHUB_TOKEN = "github-token";
    process.env.GITHUB_PAT = "github-pat";
    process.env.GH_TOKEN = "gh-token";

    expect(getGithubTokenFromEnv()).toBe("github-token");
  });

  it("falls back through PAT env vars", () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_PAT = "github-pat";
    process.env.GH_TOKEN = "gh-token";
    expect(getGithubTokenFromEnv()).toBe("github-pat");

    delete process.env.GITHUB_PAT;
    expect(getGithubTokenFromEnv()).toBe("gh-token");
  });

  it("treats ghs_ tokens as ephemeral and non-persistable", () => {
    expect(isEphemeralGithubToken("ghs_shortlived")).toBe(true);
    expect(shouldPersistGithubToken("ghs_shortlived")).toBe(false);
  });

  it("treats PAT and OAuth tokens as persistable", () => {
    expect(shouldPersistGithubToken("ghp_pat")).toBe(true);
    expect(shouldPersistGithubToken("github_pat_long")).toBe(true);
    expect(shouldPersistGithubToken("gho_oauth")).toBe(true);
  });
});
