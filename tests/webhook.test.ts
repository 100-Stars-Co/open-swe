import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { app } from "../src/webapp.js";

const GITHUB_SECRET = "test-github-secret";
const JIRA_SECRET = "test-jira-secret";

function makeGithubSignature(body: string, secret = GITHUB_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeJiraSignature(body: string, secret = JIRA_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("webhook signature verification", () => {
  let originalGithubSecret: string | undefined;
  let originalJiraSecret: string | undefined;

  beforeEach(() => {
    originalGithubSecret = process.env.GITHUB_WEBHOOK_SECRET;
    originalJiraSecret = process.env.JIRA_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = GITHUB_SECRET;
    process.env.JIRA_WEBHOOK_SECRET = JIRA_SECRET;
  });

  afterEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = originalGithubSecret;
    process.env.JIRA_WEBHOOK_SECRET = originalJiraSecret;
  });

  describe("GET /health", () => {
    it("returns 200 with status ok", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
    });
  });

  describe("POST /webhooks/github", () => {
    it("returns 403 for request with no signature", async () => {
      const payload = JSON.stringify({ action: "opened" });
      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": "issues" },
        body: payload,
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 for request with wrong signature", async () => {
      const payload = JSON.stringify({ action: "opened" });
      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body: payload,
      });
      expect(res.status).toBe(403);
    });

    it("returns 200 for request with correct signature", async () => {
      const payload = JSON.stringify({ action: "opened", repository: { owner: { login: "test" }, name: "repo" } });
      const sig = makeGithubSignature(payload);
      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "ping",
          "x-hub-signature-256": sig,
        },
        body: payload,
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /webhooks/jira", () => {
    it("returns 403 for request with wrong signature", async () => {
      const payload = JSON.stringify({ webhookEvent: "jira:issue_created" });
      const res = await app.request("/webhooks/jira", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature": "sha256=wrongsig",
        },
        body: payload,
      });
      expect(res.status).toBe(403);
    });

    it("returns 200 for request with correct signature", async () => {
      const payload = JSON.stringify({ webhookEvent: "jira:issue_created" });
      const sig = makeJiraSignature(payload);
      const res = await app.request("/webhooks/jira", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature": sig,
        },
        body: payload,
      });
      expect(res.status).toBe(200);
    });
  });
});
