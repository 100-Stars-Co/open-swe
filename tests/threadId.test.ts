import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { generateThreadIdFromJiraIssue } from "../src/utils/jiraWebhook.js";

// Use crypto directly to generate a GitHub thread ID for testing
import { createHash } from "node:crypto";

function generateGithubThreadId(owner: string, repo: string, issueNumber: number): string {
  const hash = createHash("sha256")
    .update(`github:${owner}/${repo}#${issueNumber}`)
    .digest("hex");
  const h = hash.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("thread ID generation", () => {
  let originalJiraBaseUrl: string | undefined;

  beforeEach(() => {
    originalJiraBaseUrl = process.env.JIRA_BASE_URL;
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
  });

  afterEach(() => {
    process.env.JIRA_BASE_URL = originalJiraBaseUrl;
  });

  describe("GitHub thread IDs", () => {
    it("produces a valid UUID v4 format", () => {
      const id = generateGithubThreadId("myorg", "myrepo", 42);
      expect(id).toMatch(UUID_PATTERN);
    });

    it("is deterministic — same inputs produce same ID", () => {
      const a = generateGithubThreadId("myorg", "myrepo", 42);
      const b = generateGithubThreadId("myorg", "myrepo", 42);
      expect(a).toBe(b);
    });

    it("produces different IDs for different issue numbers", () => {
      const a = generateGithubThreadId("myorg", "myrepo", 42);
      const b = generateGithubThreadId("myorg", "myrepo", 43);
      expect(a).not.toBe(b);
    });

    it("produces different IDs for different repos", () => {
      const a = generateGithubThreadId("myorg", "repo-a", 1);
      const b = generateGithubThreadId("myorg", "repo-b", 1);
      expect(a).not.toBe(b);
    });
  });

  describe("Jira thread IDs", () => {
    it("produces a valid UUID v4 format", () => {
      const id = generateThreadIdFromJiraIssue("PROJ-123");
      expect(id).toMatch(UUID_PATTERN);
    });

    it("is deterministic — same issue key produces same ID", () => {
      const a = generateThreadIdFromJiraIssue("PROJ-123");
      const b = generateThreadIdFromJiraIssue("PROJ-123");
      expect(a).toBe(b);
    });

    it("produces different IDs for different issue keys", () => {
      const a = generateThreadIdFromJiraIssue("PROJ-1");
      const b = generateThreadIdFromJiraIssue("PROJ-2");
      expect(a).not.toBe(b);
    });

    it("is different from the GitHub thread ID for similar-looking keys", () => {
      const jiraId = generateThreadIdFromJiraIssue("myorg/myrepo#42");
      const githubId = generateGithubThreadId("myorg", "myrepo", 42);
      // They use different namespaces so must differ
      expect(jiraId).not.toBe(githubId);
    });
  });
});
