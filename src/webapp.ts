/**
 * Webhook HTTP server — Hono app with GitHub and Jira webhook handlers.
 * Mirrors agent/webapp.py
 *
 * All webhook handlers return 200 immediately and process asynchronously.
 * Signature verification is strict — unverified requests are rejected with 403.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Client } from "@langchain/langgraph-sdk";
import { queueMessageForThread } from "./middleware/checkMessageQueue.js";
import {
  parseJiraIssuePayload,
  parseJiraCommentPayload,
} from "./utils/jiraWebhook.js";

const app = new Hono();

// ─── LangGraph client ─────────────────────────────────────────────────────────

function getLangGraphClient(): Client {
  return new Client({
    apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024",
  });
}

// ─── Thread management ────────────────────────────────────────────────────────

/**
 * Generate a deterministic UUID-formatted thread ID from a GitHub issue.
 */
function generateGithubThreadId(owner: string, repo: string, issueNumber: number): string {
  const hash = createHash("sha256")
    .update(`github:${owner}/${repo}#${issueNumber}`)
    .digest("hex");
  return formatAsUuid(hash);
}

function formatAsUuid(hex: string): string {
  const h = hex.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

/**
 * Check whether a LangGraph thread is currently running (busy).
 */
async function isThreadActive(threadId: string): Promise<boolean> {
  try {
    const client = getLangGraphClient();
    const thread = await client.threads.get(threadId);
    return (thread as unknown as Record<string, unknown>)?.status === "busy";
  } catch {
    return false;
  }
}

/**
 * Ensure a thread exists, creating it if not.
 */
async function ensureThread(threadId: string): Promise<void> {
  const client = getLangGraphClient();
  try {
    await client.threads.get(threadId);
  } catch {
    await client.threads.create({ threadId });
  }
}

/**
 * Create a new agent run on a thread.
 */
async function createRun(
  threadId: string,
  input: Record<string, unknown>,
  config?: Record<string, unknown>,
): Promise<void> {
  const client = getLangGraphClient();
  await client.runs.create(threadId, "agent", {
    input: { messages: [{ role: "human", content: input.message as string }] },
    config: { configurable: config ?? {} },
  });
}

// ─── Signature verification ───────────────────────────────────────────────────

function githubSignatureValid(body: Buffer, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function jiraSignatureValid(body: Buffer, signature: string | null): boolean {
  const secret = process.env.JIRA_WEBHOOK_SECRET;
  if (!secret) return true; // If no secret configured, skip verification
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Org allowlist ────────────────────────────────────────────────────────────

function isOrgAllowed(owner: string): boolean {
  const allowList = process.env.ALLOWED_GITHUB_ORGS ?? "";
  if (!allowList.trim()) return true; // Empty = allow all
  return allowList.split(",").map((s) => s.trim()).includes(owner);
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", service: "openswe-js" }));

// ─── GitHub webhooks ──────────────────────────────────────────────────────────

app.get("/webhooks/github", (c) => {
  // GitHub App webhook delivery verification ping
  return c.json({ ok: true });
});

app.post("/webhooks/github", async (c) => {
  const rawBody = Buffer.from(await c.req.arrayBuffer());
  const signature = c.req.header("x-hub-signature-256") ?? null;

  if (!githubSignatureValid(rawBody, signature)) {
    return c.json({ error: "Invalid signature" }, 403);
  }

  const event = c.req.header("x-github-event") ?? "";
  // biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped
  const payload = JSON.parse(rawBody.toString("utf-8")) as Record<string, any>;

  // Handle async so we can return 200 immediately
  handleGithubEvent(event, payload).catch((err) => {
    console.error("[github webhook] Error:", err);
  });

  return c.json({ ok: true });
});

// biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped
async function handleGithubEvent(event: string, payload: Record<string, any>): Promise<void> {
  const action = payload.action as string;
  const repo = payload.repository as { owner: { login: string }; name: string } | undefined;
  if (!repo) return;

  const owner = repo.owner.login;
  const repoName = repo.name;

  if (!isOrgAllowed(owner)) {
    console.log(`[github] Ignoring event from non-allowed org: ${owner}`);
    return;
  }

  // Issue opened — treat as a new task
  if (event === "issues" && action === "opened") {
    const issue = payload.issue as {
      number: number;
      title: string;
      body: string;
      user: { login: string };
    };
    const threadId = generateGithubThreadId(owner, repoName, issue.number);
    await ensureThread(threadId);

    const message = [
      `GitHub Issue #${issue.number} opened by @${issue.user.login}`,
      `**Title:** ${issue.title}`,
      issue.body ? `\n**Description:**\n${issue.body}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await createRun(threadId, { message }, {
      thread_id: threadId,
      repo: { owner, name: repoName },
      issue_number: issue.number,
      source: "github",
    });
    return;
  }

  // Issue comment containing @mention
  if (event === "issue_comment" && action === "created") {
    const issue = payload.issue as { number: number; pull_request?: unknown };
    const comment = payload.comment as { body: string; user: { login: string } };

    // Only handle issue comments, not PR comments via this event
    if (issue.pull_request) return;

    const threadId = generateGithubThreadId(owner, repoName, issue.number);

    const message = [
      `Comment by @${comment.user.login} on issue #${issue.number}:`,
      comment.body,
    ].join("\n");

    const active = await isThreadActive(threadId);
    if (active) {
      await queueMessageForThread(threadId, message);
    } else {
      await ensureThread(threadId);
      await createRun(threadId, { message }, {
        thread_id: threadId,
        repo: { owner, name: repoName },
        issue_number: issue.number,
        source: "github",
      });
    }
    return;
  }

  // PR review comment mentioning the bot
  if (event === "pull_request_review_comment" && action === "created") {
    const pr = payload.pull_request as { number: number };
    const comment = payload.comment as { body: string; user: { login: string } };

    const threadId = generateGithubThreadId(owner, repoName, pr.number);

    const message = [
      `PR review comment by @${comment.user.login} on PR #${pr.number}:`,
      comment.body,
    ].join("\n");

    const active = await isThreadActive(threadId);
    if (active) {
      await queueMessageForThread(threadId, message);
    } else {
      await ensureThread(threadId);
      await createRun(threadId, { message }, {
        thread_id: threadId,
        repo: { owner, name: repoName },
        issue_number: pr.number,
        source: "github",
      });
    }
  }
}

// ─── Jira webhooks ────────────────────────────────────────────────────────────

app.get("/webhooks/jira", (c) => c.json({ ok: true }));

app.post("/webhooks/jira", async (c) => {
  const rawBody = Buffer.from(await c.req.arrayBuffer());
  const signature = c.req.header("x-hub-signature") ?? null;

  if (!jiraSignatureValid(rawBody, signature)) {
    return c.json({ error: "Invalid signature" }, 403);
  }

  // biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped
  const payload = JSON.parse(rawBody.toString("utf-8")) as Record<string, any>;
  const event = payload.webhookEvent as string;

  handleJiraEvent(event, payload).catch((err) => {
    console.error("[jira webhook] Error:", err);
  });

  return c.json({ ok: true });
});

// biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped
async function handleJiraEvent(event: string, payload: Record<string, any>): Promise<void> {
  const repoOwner =
    process.env.DEFAULT_REPO_OWNER ?? "";
  const repoName =
    process.env.DEFAULT_REPO_NAME ?? "";

  if (!repoOwner || !repoName) {
    console.warn("[jira] DEFAULT_REPO_OWNER / DEFAULT_REPO_NAME not set — skipping run creation");
    return;
  }

  if (event === "jira:issue_created") {
    const ctx = parseJiraIssuePayload(payload);
    if (!ctx) return;

    await ensureThread(ctx.threadId);

    const message = [
      `Jira issue created: ${ctx.issueKey}`,
      `**Summary:** ${ctx.issueSummary}`,
      ctx.issueDescription ? `\n**Description:**\n${ctx.issueDescription}` : "",
      `**Reporter:** ${ctx.reporterDisplayName} (${ctx.reporterEmail})`,
    ]
      .filter(Boolean)
      .join("\n");

    await createRun(ctx.threadId, { message }, {
      thread_id: ctx.threadId,
      repo: { owner: repoOwner, name: repoName },
      source: "jira",
      jira_project_key: ctx.projectKey,
      jira_issue_key: ctx.issueKey,
    });
    return;
  }

  if (event === "comment_created") {
    const ctx = parseJiraCommentPayload(payload);
    if (!ctx) return;

    const message = [
      `Comment by ${ctx.authorDisplayName} on Jira issue ${ctx.issueKey}:`,
      ctx.commentBody,
    ].join("\n");

    const active = await isThreadActive(ctx.threadId);
    if (active) {
      await queueMessageForThread(ctx.threadId, message);
    } else {
      await ensureThread(ctx.threadId);
      await createRun(ctx.threadId, { message }, {
        thread_id: ctx.threadId,
        repo: { owner: repoOwner, name: repoName },
        source: "jira",
        jira_issue_key: ctx.issueKey,
      });
    }
  }
}

// ─── Server ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8000", 10);

if (process.argv[1] === new URL(import.meta.url).pathname) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[openswe-js] Webhook server running at http://localhost:${info.port}`);
  });
}

export { app };
