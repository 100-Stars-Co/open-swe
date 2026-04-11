/**
 * Webhook HTTP server — Hono app with GitHub and Jira webhook handlers.
 * Mirrors agent/webapp.py
 *
 * All webhook handlers return 200 immediately and process asynchronously.
 * Signature verification is strict — unverified requests are rejected with 403.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { enqueueThreadRun, removeThreadRunJob } from "./queue/threadQueue.js";
import { getAgentStateStore } from "./state/index.js";
import { addReactionToComment, addReactionToIssue } from "./utils/github.js";
import { getInstallationToken } from "./utils/githubApp.js";
import { parseJiraCommentPayload, parseJiraIssuePayload } from "./utils/jiraWebhook.js";
import { cleanupSandboxForThread } from "./utils/sandboxLifecycle.js";
import { getSandboxMetadata } from "./utils/sandboxState.js";
import {
  generateThreadIdFromTelegramChat,
  getTelegramRepoConfig,
  isBotMentioned,
  stripBotMention,
  verifyTelegramSecret,
} from "./utils/telegram.js";
import { getTraceUrl } from "./utils/tracing.js";

const app = new Hono();

// ─── Static files for monitor dashboard ─────────────────────────────────────────
// Explicit routes for monitor assets to ensure correct resolution

app.get("/monitor/", async (c) => {
  try {
    const filePath = new URL("./monitor/index.html", import.meta.url);
    const file = Bun.file(filePath);
    const html = await file.text();
    return c.html(html);
  } catch (err) {
    console.error("Error serving monitor page:", err);
    return c.text("Error loading dashboard", 500);
  }
});

app.get("/monitor/app.js", async (c) => {
  try {
    const filePath = new URL("./monitor/app.js", import.meta.url);
    const file = Bun.file(filePath);
    const content = await file.text();
    return c.body(content, {
      headers: { "Content-Type": "application/javascript; charset=UTF-8" },
    });
  } catch (err) {
    console.error("Error serving app.js:", err);
    return c.text("Error loading script", 500);
  }
});

app.get("/monitor", (c) => {
  return c.redirect("/monitor/");
});

// ─── Thread management ────────────────────────────────────────────────────────

/**
 * Generate a deterministic UUID-formatted thread ID from a GitHub issue.
 */
function generateGithubThreadId(owner: string, repo: string, issueNumber: number): string {
  const hash = createHash("sha256").update(`github:${owner}/${repo}#${issueNumber}`).digest("hex");
  return formatAsUuid(hash);
}

function formatAsUuid(hex: string): string {
  const h = hex.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

async function isThreadActive(threadId: string): Promise<boolean> {
  const thread = await getAgentStateStore().getThread(threadId);
  return thread?.status === "busy";
}

function extractThreadFields(config?: Record<string, unknown>): {
  source?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  issueNumber?: number | null;
} {
  const repo = config?.repo as { owner?: string; name?: string } | undefined;
  const issueNumber =
    typeof config?.issue_number === "number" ? (config.issue_number as number) : null;

  return {
    source: (config?.source as string | undefined) ?? null,
    repoOwner: repo?.owner ?? null,
    repoName: repo?.name ?? null,
    issueNumber,
  };
}

async function ensureThread(threadId: string, config?: Record<string, unknown>): Promise<void> {
  const fields = extractThreadFields(config);
  await getAgentStateStore().upsertThread({
    threadId,
    source: fields.source ?? null,
    repoOwner: fields.repoOwner ?? null,
    repoName: fields.repoName ?? null,
    issueNumber: fields.issueNumber ?? null,
    configurable: config ?? {},
    metadata: config?.source ? { source: config.source as string } : undefined,
  });
}

async function enqueueAgentMessage(
  threadId: string,
  message: string,
  config?: Record<string, unknown>,
): Promise<void> {
  await ensureThread(threadId, config);
  await getAgentStateStore().enqueueMessage(threadId, message);
  if (!(await isThreadActive(threadId))) {
    await enqueueThreadRun(threadId);
  }
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
  return allowList
    .split(",")
    .map((s) => s.trim())
    .includes(owner);
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", service: "openswe-js" }));

// ─── Thread Monitoring API ────────────────────────────────────────────────────

/**
 * List all threads with their status and metadata.
 * Returns threads sorted by most recently active.
 */
app.get("/api/threads", async (c) => {
  try {
    const threads = await getAgentStateStore().listThreads(100);
    const enrichedThreads = await Promise.all(
      threads.map(async (thread) => {
        const threadId = thread.threadId;
        const sandboxMeta = await getSandboxMetadata(threadId);
        return {
          threadId,
          status: thread.status,
          createdAt: thread.createdAt,
          metadata: {
            ...thread.metadata,
            source: thread.source,
            sandboxId: sandboxMeta.sandboxId,
            repoDir: sandboxMeta.repoDir,
            branchName: sandboxMeta.branchName,
            baseBranch: sandboxMeta.baseBranch,
          },
        };
      }),
    );

    return c.json({ threads: enrichedThreads });
  } catch (error) {
    console.error("[api/threads] Error fetching threads:", error);
    return c.json({ error: "Failed to fetch threads" }, 500);
  }
});

/**
 * Get detailed information about a specific thread.
 */
app.get("/api/threads/:id", async (c) => {
  const threadId = c.req.param("id");
  try {
    const thread = await getAgentStateStore().getThread(threadId);
    if (!thread) {
      return c.json({ error: "Thread not found" }, 404);
    }
    const sandboxMeta = await getSandboxMetadata(threadId);
    const queuedMessages = (await getAgentStateStore().listPendingMessages(threadId)).map(
      (item) => item.message,
    );

    return c.json({
      threadId: thread.threadId,
      status: thread.status,
      metadata: {
        ...thread.metadata,
        source: thread.source,
        sandboxId: sandboxMeta.sandboxId,
        repoDir: sandboxMeta.repoDir,
        branchName: sandboxMeta.branchName,
        baseBranch: sandboxMeta.baseBranch,
      },
      queuedMessages,
    });
  } catch (error) {
    console.error(`[api/threads/${threadId}] Error fetching thread:`, error);
    return c.json({ error: "Thread not found" }, 404);
  }
});

/**
 * Get event/runs history for a thread.
 */
app.get("/api/threads/:id/runs", async (c) => {
  const threadId = c.req.param("id");
  try {
    const runs = await getAgentStateStore().listRuns(threadId);

    const enrichedRuns = runs.map((run) => ({
        runId: run.runId,
        status: run.status,
        traceUrl: getTraceUrl(run.runId),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }));

    return c.json({ runs: enrichedRuns });
  } catch (error) {
    console.error(`[api/threads/${threadId}/runs] Error fetching runs:`, error);
    return c.json({ runs: [] });
  }
});

/**
 * Interrupt/stop a running thread without deleting it.
 * Cancels any active runs for the thread.
 */
app.post("/api/threads/:id/stop", async (c) => {
  const threadId = c.req.param("id");
  try {
    const thread = await getAgentStateStore().getThread(threadId);
    if (!thread) {
      return c.json({ error: "Thread not found" }, 404);
    }

    if (thread.status !== "busy") {
      return c.json({ success: true, message: "Thread is not running" });
    }

    await getAgentStateStore().updateThread(threadId, {
      interruptionRequested: true,
    });

    return c.json({
      success: true,
      message: "Stop requested for running thread",
      cancelledRuns: 0,
    });
  } catch (error) {
    console.error(`[api/threads/${threadId}/stop] Error stopping thread:`, error);
    return c.json({ error: "Failed to stop thread" }, 500);
  }
});

/**
 * Delete a thread and its associated sandbox.
 * Also cancels any active runs before deletion.
 */
app.delete("/api/threads/:id", async (c) => {
  const threadId = c.req.param("id");
  const forceDelete = c.req.query("force") === "true";
  try {
    const thread = await getAgentStateStore().getThread(threadId);
    if (!thread) {
      return c.json({ success: true, message: "Thread not found" });
    }
    await removeThreadRunJob(threadId).catch((err) => {
      console.warn(`[api/threads/${threadId}] Failed to remove queued worker job:`, err);
    });

    const sandboxMeta = await getSandboxMetadata(threadId);

    try {
      await cleanupSandboxForThread(threadId, sandboxMeta.sandboxId);
    } catch (cleanupErr) {
      const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.error(`[api/threads/${threadId}] Sandbox cleanup failed:`, cleanupErr);
      if (!forceDelete) {
        return c.json(
          {
            error: `Failed to clean up sandbox: ${message}`,
            canForceDelete: true,
            cleanupFailed: true,
          },
          500,
        );
      }
    }

    await getAgentStateStore().deleteThread(threadId);

    return c.json({
      success: true,
      message: forceDelete ? "Thread deleted without sandbox cleanup" : "Thread deleted",
    });
  } catch (error) {
    console.error(`[api/threads/${threadId}] Error deleting thread:`, error);
    return c.json({ error: "Failed to delete thread" }, 500);
  }
});

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

async function handleGithubEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  const action = payload.action as string;
  const repo = payload.repository as { owner: { login: string }; name: string } | undefined;
  if (!repo) return;

  const owner = repo.owner.login;
  const repoName = repo.name;

  if (!isOrgAllowed(owner)) {
    console.log(`[github] Ignoring event from non-allowed org: ${owner}`);
    return;
  }

  const botUsername = process.env.GITHUB_BOT_USERNAME ?? "openswe";

  // Issue opened — treat as a new task
  if (event === "issues" && action === "opened") {
    const issue = payload.issue as {
      number: number;
      title: string;
      body: string;
      user: { login: string };
    };

    // Only respond if bot is mentioned in title or body
    if (!isBotMentioned(issue.title + (issue.body || ""), botUsername)) {
      return;
    }

    // Acknowledge with a reaction
    const token = await getInstallationToken();
    if (token) {
      await addReactionToIssue(owner, repoName, issue.number, "eyes", token).catch((err) =>
        console.error("[github] Failed to add reaction to issue:", err),
      );
    }

    const threadId = generateGithubThreadId(owner, repoName, issue.number);

    const message = [
      `GitHub Issue #${issue.number} opened by @${issue.user.login}`,
      `**Title:** ${issue.title}`,
      issue.body ? `\n**Description:**\n${issue.body}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await enqueueAgentMessage(threadId, message, {
        thread_id: threadId,
        repo: { owner, name: repoName },
        issue_number: issue.number,
        source: "github",
      });
    return;
  }

  // Issue comment containing @mention
  if (event === "issue_comment" && (action === "created" || action === "edited")) {
    const issue = payload.issue as { number: number; pull_request?: unknown };
    const comment = payload.comment as {
      id: number;
      body: string;
      user: { login: string };
    };

    // Only handle issue comments, not PR comments via this event
    if (issue.pull_request) return;

    // Only respond if bot is mentioned
    if (!isBotMentioned(comment.body, botUsername)) {
      return;
    }

    // Acknowledge with a reaction
    const token = await getInstallationToken();
    if (token) {
      await addReactionToComment(owner, repoName, comment.id, "eyes", token).catch((err) =>
        console.error("[github] Failed to add reaction to comment:", err),
      );
    }

    const threadId = generateGithubThreadId(owner, repoName, issue.number);
    const message = [
      `Comment by @${comment.user.login} on issue #${issue.number}:`,
      comment.body,
    ].join("\n");

    await enqueueAgentMessage(threadId, message, {
      thread_id: threadId,
      repo: { owner, name: repoName },
      issue_number: issue.number,
      source: "github",
    });
    return;
  }

  // PR review comment mentioning the bot
  if (event === "pull_request_review_comment" && (action === "created" || action === "edited")) {
    const pr = payload.pull_request as { number: number };
    const comment = payload.comment as {
      id: number;
      body: string;
      user: { login: string };
    };

    // Only respond if bot is mentioned
    if (!isBotMentioned(comment.body, botUsername)) {
      return;
    }

    // Acknowledge with a reaction
    const token = await getInstallationToken();
    if (token) {
      await addReactionToComment(owner, repoName, comment.id, "eyes", token).catch((err) =>
        console.error("[github] Failed to add reaction to PR comment:", err),
      );
    }

    const threadId = generateGithubThreadId(owner, repoName, pr.number);

    const message = [
      `PR review comment by @${comment.user.login} on PR #${pr.number}:`,
      comment.body,
    ].join("\n");

    await enqueueAgentMessage(threadId, message, {
      thread_id: threadId,
      repo: { owner, name: repoName },
      issue_number: pr.number,
      source: "github",
    });
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

  const payload = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
  const event = payload.webhookEvent as string;

  handleJiraEvent(event, payload).catch((err) => {
    console.error("[jira webhook] Error:", err);
  });

  return c.json({ ok: true });
});

async function handleJiraEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  const repoOwner = process.env.DEFAULT_REPO_OWNER ?? "";
  const repoName = process.env.DEFAULT_REPO_NAME ?? "";

  if (!repoOwner || !repoName) {
    console.warn("[jira] DEFAULT_REPO_OWNER / DEFAULT_REPO_NAME not set — skipping run creation");
    return;
  }

  if (event === "jira:issue_created") {
    const ctx = parseJiraIssuePayload(payload);
    if (!ctx) return;

    const message = [
      `Jira issue created: ${ctx.issueKey}`,
      `**Summary:** ${ctx.issueSummary}`,
      ctx.issueDescription ? `\n**Description:**\n${ctx.issueDescription}` : "",
      `**Reporter:** ${ctx.reporterDisplayName} (${ctx.reporterEmail})`,
    ]
      .filter(Boolean)
      .join("\n");

    await enqueueAgentMessage(ctx.threadId, message, {
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

    await enqueueAgentMessage(ctx.threadId, message, {
      thread_id: ctx.threadId,
      repo: { owner: repoOwner, name: repoName },
      source: "jira",
      jira_issue_key: ctx.issueKey,
    });
  }
}

// ─── Telegram webhooks ────────────────────────────────────────────────────────

app.get("/webhooks/telegram", (c) => c.json({ ok: true }));

app.post("/webhooks/telegram", async (c) => {
  const rawBody = Buffer.from(await c.req.arrayBuffer());
  const secretToken = c.req.header("x-telegram-bot-api-secret-token") ?? "";
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

  if (!verifyTelegramSecret(secretToken, webhookSecret)) {
    return c.json({ error: "Invalid secret token" }, 403);
  }

  const payload = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;

  handleTelegramUpdate(payload).catch((err) => {
    console.error("[telegram webhook] Error:", err);
  });

  return c.json({ ok: true });
});

async function handleTelegramUpdate(update: Record<string, unknown>): Promise<void> {
  const message = update.message as Record<string, unknown> | undefined;
  if (!message) return;

  const text = (message.text as string) ?? "";
  const chatId = (message.chat as Record<string, unknown>)?.id as number | undefined;
  const messageId = message.message_id as number | undefined;
  const messageThreadId = (message.message_thread_id as number) ?? undefined;
  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? "";

  if (!chatId || !text) return;

  // Only respond to messages that mention the bot (in groups) or all messages in private chats
  const chatType = (message.chat as Record<string, unknown>)?.type as string;
  if (chatType !== "private" && botUsername && !isBotMentioned(text, botUsername)) {
    return;
  }

  const cleanText = stripBotMention(text, botUsername);
  if (!cleanText.trim()) return;

  const repoConfig = getTelegramRepoConfig(cleanText);
  if (!repoConfig.owner || !repoConfig.name) {
    console.warn("[telegram] No repo config found — skipping");
    return;
  }

  const threadId = generateThreadIdFromTelegramChat(chatId, messageThreadId);
  const senderName = ((message.from as Record<string, unknown>)?.first_name as string) ?? "User";

  const agentMessage = [
    "You were mentioned in Telegram.",
    "",
    "## Repository",
    `${repoConfig.owner}/${repoConfig.name}`,
    "",
    "## Triggered by",
    senderName,
    "",
    "## Telegram Chat",
    `- Chat ID: ${chatId}`,
    messageThreadId !== undefined ? `- Message Thread ID: ${messageThreadId}` : null,
    messageId !== undefined ? `- Reply to Message ID: ${messageId}` : null,
    "",
    "## Latest Request",
    cleanText,
    "",
    "Use `telegram_reply` to communicate in this Telegram chat for clarifications, status updates, and final summaries.",
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");

  await enqueueAgentMessage(threadId, agentMessage, {
    thread_id: threadId,
    repo: { owner: repoConfig.owner, name: repoConfig.name },
    source: "telegram",
    telegram_chat: {
      chat_id: chatId,
      reply_to_message_id: messageId,
      message_thread_id: messageThreadId,
    },
  });
}

export { app };
