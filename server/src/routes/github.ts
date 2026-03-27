/**
 * GitHub webhook route handler.
 * Ports the GitHub webhook logic from agent/webapp.py to Hono + TypeScript.
 */

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { config, GITHUB_BOT_MESSAGE_PREFIXES, isRepoOrgAllowed } from "../utils/config.ts";
import {
  OPEN_SWE_TAGS,
  verifyGithubSignature,
  getThreadIdFromBranch,
  formatGithubCommentBodyForPrompt,
  sanitizeGithubCommentBody,
  reactToGithubComment,
  fetchIssueComments,
  fetchPrCommentsSinceLastTag,
  fetchPrBranch,
  buildPrPrompt,
  type GithubComment,
} from "../utils/github-comments.ts";
import { getGithubAppInstallationToken } from "../utils/github-app.ts";
import { getOrResolveThreadGithubToken } from "../utils/auth.ts";
import {
  getLangGraphClient,
  isThreadActive,
  queueMessageForThread,
  threadExists,
  isNotFoundError,
} from "../utils/langgraph.ts";
import { GITHUB_USER_EMAIL_MAP } from "../constants/github-user-email-map.ts";

const app = new Hono();

const SUPPORTED_GH_EVENTS = new Set([
  "issue_comment",
  "issues",
  "pull_request_review_comment",
  "pull_request_review",
]);
const SUPPORTED_GH_ISSUE_ACTIONS = new Set(["edited", "opened", "reopened"]);
const UUID_NAMESPACE_URL = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

/** Generate a UUID v5 (SHA-1 name-based) compatible with Python's uuid.uuid5(NAMESPACE_URL, name). */
function uuidv5(name: string): string {
  const hash = createHash("sha1")
    .update(Buffer.concat([UUID_NAMESPACE_URL, Buffer.from(name, "utf-8")]))
    .digest();
  // Set version bits (version 5)
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  // Set variant bits
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Generate a deterministic LangGraph thread ID from a GitHub issue ID. */
function generateThreadIdFromGithubIssue(issueId: string): string {
  const hex = createHash("sha256").update(`github-issue:${issueId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildGithubIssueCommentsText(comments: GithubComment[]): string {
  const lines: string[] = [];
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (!body || GITHUB_BOT_MESSAGE_PREFIXES.some((p) => body.startsWith(p))) continue;
    const formatted = formatGithubCommentBodyForPrompt(comment.author, body);
    lines.push(`\n**${comment.author}:**\n${formatted}\n`);
  }
  if (!lines.length) return "";
  return "\n\n## Comments:\n" + lines.join("");
}

function buildGithubIssuePrompt(opts: {
  repoConfig: { owner: string; name: string };
  issueNumber: number;
  issueId: string;
  title: string;
  body: string;
  comments: GithubComment[];
  githubLogin: string;
  issueAuthor?: string;
}): string {
  const { repoConfig, issueNumber, issueId, title, body, comments, githubLogin, issueAuthor } = opts;
  const triggeredByLine = githubLogin ? `## Triggered by: ${githubLogin}\n\n` : "";
  const commentsText = buildGithubIssueCommentsText(comments);
  const sanitizedTitle = sanitizeGithubCommentBody(title);
  const formattedBody = formatGithubCommentBodyForPrompt(issueAuthor ?? githubLogin, body);
  return (
    "Please work on the following GitHub issue:\n\n" +
    `## Repository: ${repoConfig.owner}/${repoConfig.name}\n\n` +
    `${triggeredByLine}` +
    `## GitHub Issue: #${issueNumber} - Issue ID: ${issueId}\n\n` +
    `## Title: ${sanitizedTitle}\n\n` +
    `## Description:\n${formattedBody}\n` +
    `${commentsText}\n\n` +
    "Please analyze this issue and implement the necessary changes. " +
    "When you need to communicate on GitHub, use `github_comment` with the issue number."
  );
}

function buildGithubIssueFollowupPrompt(githubLogin: string, commentBody: string): string {
  return `**${githubLogin}:**\n${formatGithubCommentBodyForPrompt(githubLogin, commentBody)}`;
}

function buildGithubIssueUpdatePrompt(githubLogin: string, title: string, body: string): string {
  const sanitizedTitle = sanitizeGithubCommentBody(title);
  const formattedBody = formatGithubCommentBodyForPrompt(githubLogin, body);
  return (
    `**${githubLogin}:** updated the GitHub issue title/body.\n\n` +
    `Title: ${sanitizedTitle}\n\n` +
    `Description:\n${formattedBody}`
  );
}

async function triggerOrQueueRun(opts: {
  threadId: string;
  prompt: string;
  githubLogin: string;
  repoConfig: { owner: string; name: string };
  prNumber: number | null;
  baseBranch?: string;
}): Promise<void> {
  const { threadId, prompt, githubLogin, repoConfig, prNumber, baseBranch } = opts;
  const threadActive = await isThreadActive(threadId);
  if (threadActive) {
    await queueMessageForThread(threadId, prompt);
    return;
  }
  const client = getLangGraphClient();
  await client.runs.create(
    threadId,
    "agent",
    {
      input: { messages: [{ role: "user", content: prompt }] },
      metadata: config.agentVersionMetadata,
      config: {
        configurable: {
          source: "github",
          github_login: githubLogin,
          repo: repoConfig,
          pr_number: prNumber,
          base_branch: baseBranch ?? "",
        },
      },
      ifNotExists: "create",
    },
  );
}

async function processGithubPrComment(
  payload: Record<string, unknown>,
  eventType: string,
): Promise<void> {
  const repo = (payload["repository"] as Record<string, unknown> | undefined) ?? {};
  const repoConfig = {
    owner: ((repo["owner"] as Record<string, unknown> | undefined)?.["login"] as string | undefined) ?? "",
    name: (repo["name"] as string | undefined) ?? "",
  };

  const prData = (payload["pull_request"] as Record<string, unknown> | undefined) ??
    (payload["issue"] as Record<string, unknown> | undefined) ?? {};
  const prNumber = (prData["number"] as number | undefined) ?? null;
  const prUrl = (prData["html_url"] as string | undefined) ?? (prData["url"] as string | undefined) ?? "";
  let branchName = ((payload["pull_request"] as Record<string, unknown> | undefined)?.["head"] as Record<string, unknown> | undefined)?.["ref"] as string | undefined ?? "";
  const baseBranch = ((payload["pull_request"] as Record<string, unknown> | undefined)?.["base"] as Record<string, unknown> | undefined)?.["ref"] as string | undefined ?? "";

  if (!branchName && prNumber) {
    branchName = await fetchPrBranch(repoConfig, prNumber);
  }

  const githubLogin = (payload["sender"] as Record<string, unknown> | undefined)?.["login"] as string | undefined ?? "";
  const comment = (payload["comment"] as Record<string, unknown> | undefined) ??
    (payload["review"] as Record<string, unknown> | undefined) ?? {};
  const commentId = comment["id"] as number | undefined ?? null;
  const nodeId = eventType === "pull_request_review" ? (comment["node_id"] as string | undefined ?? null) : null;

  let threadId = branchName ? getThreadIdFromBranch(branchName) : null;
  const client = getLangGraphClient();

  if (!threadId) {
    if (!prNumber) return;
    const stableKey = `${repoConfig.owner}/${repoConfig.name}/pr/${prNumber}`;
    threadId = uuidv5(stableKey);
    const threadMetadata: Record<string, string> = { branch_name: branchName };
    if (baseBranch) threadMetadata["base_branch"] = baseBranch;
    try {
      await client.threads.update(threadId, { metadata: threadMetadata });
    } catch (err) {
      if (isNotFoundError(err)) {
        await client.threads.create({ threadId, ifExists: "do_nothing", metadata: threadMetadata });
      }
    }
  } else if (baseBranch) {
    try {
      await client.threads.update(threadId, { metadata: { base_branch: baseBranch } });
    } catch {
      // best-effort
    }
  }

  const email = GITHUB_USER_EMAIL_MAP[githubLogin] ?? "";
  if (!email) return;

  const githubToken = await getOrResolveThreadGithubToken(threadId);
  if (!githubToken) return;

  if (commentId) {
    await reactToGithubComment(repoConfig, commentId, {
      eventType,
      token: githubToken,
      pullNumber: prNumber,
      nodeId,
    });
  }

  if (!prNumber) return;

  const comments = await fetchPrCommentsSinceLastTag(repoConfig, prNumber, githubToken);
  if (!comments.length) return;

  const prompt = buildPrPrompt(comments, prUrl);
  await triggerOrQueueRun({ threadId, prompt, githubLogin, repoConfig, prNumber, baseBranch });
}

async function processGithubIssue(
  payload: Record<string, unknown>,
  eventType: string,
): Promise<void> {
  const issue = (payload["issue"] as Record<string, unknown> | undefined) ?? {};
  const repo = (payload["repository"] as Record<string, unknown> | undefined) ?? {};
  const repoConfig = {
    owner: ((repo["owner"] as Record<string, unknown> | undefined)?.["login"] as string | undefined) ?? "",
    name: (repo["name"] as string | undefined) ?? "",
  };

  const issueId = String(issue["id"] ?? "");
  const issueNumber = issue["number"] as number | undefined ?? null;
  const githubLogin = (payload["sender"] as Record<string, unknown> | undefined)?.["login"] as string | undefined ?? "";
  const issueUrl = (issue["html_url"] as string | undefined) ?? (issue["url"] as string | undefined) ?? "";
  const title = (issue["title"] as string | undefined) ?? "No title";
  const description = (issue["body"] as string | undefined) ?? "No description";
  const issueAuthor = ((issue["user"] as Record<string, unknown> | undefined)?.["login"] as string | undefined) ?? "";

  if (!issueId || !issueNumber) return;

  const email = GITHUB_USER_EMAIL_MAP[githubLogin] ?? "";
  if (!email) return;

  const threadId = generateThreadIdFromGithubIssue(issueId);
  const existingThread = await threadExists(threadId);
  const githubToken = await getOrResolveThreadGithubToken(threadId);
  const appToken = await getGithubAppInstallationToken();
  const reactionToken = githubToken ?? appToken;

  const comment = (payload["comment"] as Record<string, unknown> | undefined) ?? {};
  const commentId = comment["id"] as number | undefined ?? null;

  if (eventType === "issue_comment" && commentId) {
    if (reactionToken) {
      await reactToGithubComment(repoConfig, commentId, {
        eventType: "issue_comment",
        token: reactionToken,
      });
    }
  }

  let prompt: string;
  if (existingThread) {
    if (eventType === "issue_comment") {
      const commentLogin = ((comment["user"] as Record<string, unknown> | undefined)?.["login"] as string | undefined) ?? githubLogin;
      prompt = buildGithubIssueFollowupPrompt(commentLogin, (comment["body"] as string | undefined) ?? "");
    } else {
      prompt = buildGithubIssueUpdatePrompt(githubLogin, title, description);
    }
  } else {
    const fetchToken = githubToken ?? appToken;
    let comments = await fetchIssueComments(repoConfig, issueNumber, fetchToken);
    if (commentId && !comments.some((c) => c.comment_id === commentId)) {
      comments.push({
        body: (comment["body"] as string | undefined) ?? "",
        author: ((comment["user"] as Record<string, unknown> | undefined)?.["login"] as string | undefined) ?? "unknown",
        created_at: (comment["created_at"] as string | undefined) ?? "",
        comment_id: commentId,
      });
      comments.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    prompt = buildGithubIssuePrompt({ repoConfig, issueNumber, issueId, title, body: description, comments, githubLogin, issueAuthor });
  }

  const configurableData = {
    source: "github",
    github_login: githubLogin,
    repo: repoConfig,
    github_issue: { id: issueId, number: issueNumber, title, url: issueUrl },
  };

  const threadActive = await isThreadActive(threadId);
  if (threadActive) {
    await queueMessageForThread(threadId, prompt);
    return;
  }

  const client = getLangGraphClient();
  await client.runs.create(
    threadId,
    "agent",
    {
      input: { messages: [{ role: "user", content: prompt }] },
      metadata: config.agentVersionMetadata,
      config: { configurable: configurableData },
      ifNotExists: "create",
    },
  );
}

// POST /webhooks/github
app.post("/", async (c) => {
  const bodyBytes = Buffer.from(await c.req.arrayBuffer());
  const signature = c.req.header("X-Hub-Signature-256") ?? "";

  if (!verifyGithubSignature(bodyBytes, signature, config.githubWebhookSecret)) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const eventType = c.req.header("X-GitHub-Event") ?? "";
  if (!SUPPORTED_GH_EVENTS.has(eventType)) {
    return c.json({ status: "ignored", reason: `Unsupported event type: ${eventType}` });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(bodyBytes.toString("utf-8"));
  } catch {
    return c.json({ status: "error", message: "Invalid JSON" });
  }

  // Org allowlist check
  const webhookRepo = (payload["repository"] as Record<string, unknown> | undefined) ?? {};
  const webhookRepoConfig = {
    owner: ((webhookRepo["owner"] as Record<string, unknown> | undefined)?.["login"] as string | undefined) ?? "",
    name: (webhookRepo["name"] as string | undefined) ?? "",
  };
  if (!isRepoOrgAllowed(webhookRepoConfig)) {
    return c.json({ status: "ignored", reason: "Repository org not in allowlist" });
  }

  const issue = (payload["issue"] as Record<string, unknown> | undefined) ?? {};
  const isPrComment = eventType === "issue_comment" && Boolean(issue["pull_request"]);
  const isIssueComment = eventType === "issue_comment" && !issue["pull_request"];
  const isIssueEvent = eventType === "issues";

  if (isIssueEvent) {
    const action = (payload["action"] as string | undefined) ?? "";
    if (!SUPPORTED_GH_ISSUE_ACTIONS.has(action)) {
      return c.json({ status: "ignored", reason: `Unsupported GitHub issue action: ${action}` });
    }
    if (action === "edited") {
      const changes = (payload["changes"] as Record<string, unknown> | undefined) ?? {};
      if (!("body" in changes) && !("title" in changes)) {
        return c.json({ status: "ignored", reason: "Issue edit did not change title or body" });
      }
    }
    const issueText = `${issue["title"] ?? ""}\n\n${issue["body"] ?? ""}`.toLowerCase();
    if (!OPEN_SWE_TAGS.some((tag) => issueText.includes(tag))) {
      return c.json({ status: "ignored", reason: "Issue does not mention @openswe or @open-swe" });
    }
    processGithubIssue(payload, eventType).catch((err) =>
      console.error("Failed to process GitHub issue:", err),
    );
    return c.json({ status: "accepted", message: "Processing GitHub issue event" });
  }

  const comment = (payload["comment"] as Record<string, unknown> | undefined) ??
    (payload["review"] as Record<string, unknown> | undefined) ?? {};
  const commentBody = (comment["body"] as string | undefined) ?? "";
  if (!OPEN_SWE_TAGS.some((tag) => commentBody.toLowerCase().includes(tag))) {
    return c.json({ status: "ignored", reason: "Comment does not mention @openswe or @open-swe" });
  }

  if (isPrComment || eventType === "pull_request_review_comment" || eventType === "pull_request_review") {
    processGithubPrComment(payload, eventType).catch((err) =>
      console.error("Failed to process GitHub PR comment:", err),
    );
    return c.json({ status: "accepted", message: `Processing ${eventType} event` });
  }

  if (isIssueComment) {
    processGithubIssue(payload, eventType).catch((err) =>
      console.error("Failed to process GitHub issue comment:", err),
    );
    return c.json({ status: "accepted", message: "Processing GitHub issue comment event" });
  }

  return c.json({ status: "ignored", reason: `Unsupported payload for event type: ${eventType}` });
});

export { app as githubRoutes };
