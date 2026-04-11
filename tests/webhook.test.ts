import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHmac } from "node:crypto";
import { getAgentStateStore, resetAgentStateStoreForTests } from "../src/state/index.js";
import { InMemoryAgentStateStore } from "../src/state/inMemoryState.js";

const GITHUB_SECRET = "test-github-secret";
const JIRA_SECRET = "test-jira-secret";
const TELEGRAM_SECRET = "test-telegram-secret";

const state = {
  installationToken: "installation-token",
  issueReactions: [] as Array<{
    owner: string;
    repo: string;
    issueNumber: number;
    reaction: string;
    token: string;
  }>,
  commentReactions: [] as Array<{
    owner: string;
    repo: string;
    commentId: number;
    reaction: string;
    token: string;
  }>,
  queuedRuns: [] as string[],
};

mock.module("../src/utils/githubApp.js", () => ({
  getInstallationToken: async () => state.installationToken,
}));

mock.module("../src/utils/github.js", () => ({
  addReactionToIssue: async (
    owner: string,
    repo: string,
    issueNumber: number,
    reaction: string,
    token: string,
  ) => {
    state.issueReactions.push({ owner, repo, issueNumber, reaction, token });
  },
  addReactionToComment: async (
    owner: string,
    repo: string,
    commentId: number,
    reaction: string,
    token: string,
  ) => {
    state.commentReactions.push({ owner, repo, commentId, reaction, token });
  },
}));

mock.module("../src/queue/threadQueue.js", () => ({
  enqueueThreadRun: async (threadId: string) => {
    state.queuedRuns.push(threadId);
  },
  removeThreadRunJob: async () => {},
}));

const { app } = await import("../src/webapp.js");

function makeGithubSignature(body: string, secret = GITHUB_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeJiraSignature(body: string, secret = JIRA_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function resetState(): void {
  state.installationToken = "installation-token";
  state.issueReactions = [];
  state.commentReactions = [];
  state.queuedRuns = [];
  resetAgentStateStoreForTests(new InMemoryAgentStateStore());
}

describe("webhook signature verification", () => {
  let originalGithubSecret: string | undefined;
  let originalJiraSecret: string | undefined;
  let originalGithubOrgs: string | undefined;
  let originalGithubBotUsername: string | undefined;
  let originalTelegramSecret: string | undefined;
  let originalTelegramBotUsername: string | undefined;
  let originalTelegramRepoOwner: string | undefined;
  let originalTelegramRepoName: string | undefined;

  beforeEach(() => {
    originalGithubSecret = process.env.GITHUB_WEBHOOK_SECRET;
    originalJiraSecret = process.env.JIRA_WEBHOOK_SECRET;
    originalGithubOrgs = process.env.ALLOWED_GITHUB_ORGS;
    originalGithubBotUsername = process.env.GITHUB_BOT_USERNAME;
    originalTelegramSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    originalTelegramBotUsername = process.env.TELEGRAM_BOT_USERNAME;
    originalTelegramRepoOwner = process.env.TELEGRAM_REPO_OWNER;
    originalTelegramRepoName = process.env.TELEGRAM_REPO_NAME;

    process.env.GITHUB_WEBHOOK_SECRET = GITHUB_SECRET;
    process.env.JIRA_WEBHOOK_SECRET = JIRA_SECRET;
    process.env.ALLOWED_GITHUB_ORGS = "";
    process.env.GITHUB_BOT_USERNAME = "openswe";
    process.env.TELEGRAM_WEBHOOK_SECRET = TELEGRAM_SECRET;
    process.env.TELEGRAM_BOT_USERNAME = "openswe_bot";
    process.env.TELEGRAM_REPO_OWNER = "default-org";
    process.env.TELEGRAM_REPO_NAME = "default-repo";

    resetState();
  });

  afterEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = originalGithubSecret;
    process.env.JIRA_WEBHOOK_SECRET = originalJiraSecret;
    process.env.ALLOWED_GITHUB_ORGS = originalGithubOrgs;
    process.env.GITHUB_BOT_USERNAME = originalGithubBotUsername;
    process.env.TELEGRAM_WEBHOOK_SECRET = originalTelegramSecret;
    process.env.TELEGRAM_BOT_USERNAME = originalTelegramBotUsername;
    process.env.TELEGRAM_REPO_OWNER = originalTelegramRepoOwner;
    process.env.TELEGRAM_REPO_NAME = originalTelegramRepoName;
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
      const payload = JSON.stringify({
        action: "opened",
        repository: { owner: { login: "test" }, name: "repo" },
      });
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

    it("reacts and queues work when an opened issue mentions the bot", async () => {
      const payload = JSON.stringify({
        action: "opened",
        repository: { owner: { login: "100-Stars-Co" }, name: "goal-tracking-agent-frontend" },
        issue: {
          number: 42,
          title: "@openswe verify the trigger",
          body: "Please inspect the repo.",
          user: { login: "puvanath" },
        },
      });

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": makeGithubSignature(payload),
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      await flushAsyncWork();

      expect(state.issueReactions).toEqual([
        {
          owner: "100-Stars-Co",
          repo: "goal-tracking-agent-frontend",
          issueNumber: 42,
          reaction: "eyes",
          token: "installation-token",
        },
      ]);
      expect(state.queuedRuns).toHaveLength(1);

      const threads = await getAgentStateStore().listThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0]?.configurable).toEqual({
        thread_id: threads[0]?.threadId,
        repo: { owner: "100-Stars-Co", name: "goal-tracking-agent-frontend" },
        issue_number: 42,
        source: "github",
      });

      const pending = await getAgentStateStore().listPendingMessages(threads[0]!.threadId);
      expect(pending.map((item) => item.message)).toEqual([
        "GitHub Issue #42 opened by @puvanath\n**Title:** @openswe verify the trigger\n\n**Description:**\nPlease inspect the repo.",
      ]);
    });

    it("ignores an opened issue that does not mention the bot", async () => {
      const payload = JSON.stringify({
        action: "opened",
        repository: { owner: { login: "100-Stars-Co" }, name: "goal-tracking-agent-frontend" },
        issue: {
          number: 43,
          title: "Verify the trigger",
          body: "No mention here.",
          user: { login: "puvanath" },
        },
      });

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": makeGithubSignature(payload),
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      await flushAsyncWork();

      expect(state.issueReactions).toHaveLength(0);
      expect(state.queuedRuns).toHaveLength(0);
      expect(await getAgentStateStore().listThreads()).toEqual([]);
    });

    it("stores new issue comments as pending work", async () => {
      const payload = JSON.stringify({
        action: "created",
        repository: { owner: { login: "100-Stars-Co" }, name: "goal-tracking-agent-frontend" },
        issue: { number: 44 },
        comment: {
          id: 777,
          body: "@openswe please follow up",
          user: { login: "puvanath" },
        },
      });

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issue_comment",
          "x-hub-signature-256": makeGithubSignature(payload),
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      await flushAsyncWork();

      expect(state.commentReactions).toHaveLength(1);
      expect(state.queuedRuns).toHaveLength(1);
      const threads = await getAgentStateStore().listThreads();
      const pending = await getAgentStateStore().listPendingMessages(threads[0]!.threadId);
      expect(pending[0]?.message).toBe("Comment by @puvanath on issue #44:\n@openswe please follow up");
    });

    it("does not react to PR issue_comment events", async () => {
      const payload = JSON.stringify({
        action: "created",
        repository: { owner: { login: "100-Stars-Co" }, name: "goal-tracking-agent-frontend" },
        issue: { number: 46, pull_request: { url: "https://api.github.com/repos/x/y/pulls/1" } },
        comment: {
          id: 779,
          body: "@openswe this is on a PR issue comment event",
          user: { login: "puvanath" },
        },
      });

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issue_comment",
          "x-hub-signature-256": makeGithubSignature(payload),
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      await flushAsyncWork();
      expect(state.commentReactions).toHaveLength(0);
      expect(state.queuedRuns).toHaveLength(0);
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

  describe("POST /webhooks/telegram", () => {
    it("stores a telegram request with explicit telegram_reply guidance", async () => {
      const payload = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 123,
          text: "@openswe_bot please inspect this",
          chat: { id: 456, type: "private" },
          from: { first_name: "Puvanath" },
        },
      });

      const res = await app.request("/webhooks/telegram", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": TELEGRAM_SECRET,
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      await flushAsyncWork();

      expect(state.queuedRuns).toHaveLength(1);
      const threads = await getAgentStateStore().listThreads();
      expect(threads[0]?.configurable).toEqual({
        thread_id: threads[0]?.threadId,
        repo: { owner: "default-org", name: "default-repo" },
        source: "telegram",
        telegram_chat: {
          chat_id: 456,
          reply_to_message_id: 123,
          message_thread_id: undefined,
        },
      });

      const pending = await getAgentStateStore().listPendingMessages(threads[0]!.threadId);
      expect(pending[0]?.message).toContain("Use `telegram_reply`");
      expect(pending[0]?.message).toContain("default-org/default-repo");
    });
  });
});
