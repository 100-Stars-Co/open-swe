/**
 * Linear webhook route handler.
 * Ports the Linear webhook logic from agent/webapp.py to Hono + TypeScript.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { config, GITHUB_BOT_MESSAGE_PREFIXES, isRepoOrgAllowed } from "../utils/config.ts";
import { extractRepoFromText } from "../utils/repo.ts";
import {
  fetchLinearIssueDetails,
  postLinearTraceComment,
  reactToLinearComment,
  type LinearComment,
  type LinearIssueDetails,
} from "../utils/linear.ts";
import { getRecentComments } from "../utils/comments.ts";
import { dedupeUrls, extractImageUrls, fetchImageBlock } from "../utils/multimodal.ts";
import { getLangGraphClient, isThreadActive, queueMessageForThread } from "../utils/langgraph.ts";
import { getRepoConfigFromTeamMapping } from "../constants/linear-team-repo-map.ts";

const app = new Hono();

/** Verify the Linear webhook signature (HMAC-SHA256). */
function verifyLinearSignature(body: Buffer, signature: string, secret: string): boolean {
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Generate a deterministic LangGraph thread ID from a Linear issue ID. */
function generateThreadIdFromIssue(issueId: string): string {
  const hex = createHash("sha256").update(`linear-issue:${issueId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function processLinearIssue(
  issueData: Record<string, unknown>,
  repoConfig: { owner: string; name: string },
): Promise<void> {
  const issueId = (issueData["id"] as string | undefined) ?? "";
  const triggeringCommentId = (issueData["triggering_comment_id"] as string | undefined) ?? "";

  if (triggeringCommentId) {
    await reactToLinearComment(triggeringCommentId, "👀");
  }

  const threadId = generateThreadIdFromIssue(issueId);

  let fullIssue: LinearIssueDetails | null = await fetchLinearIssueDetails(issueId);
  if (!fullIssue) fullIssue = issueData as unknown as LinearIssueDetails;

  const commentAuthor = issueData["comment_author"] as Record<string, string> | undefined;
  let userEmail: string | undefined = commentAuthor?.["email"];
  let userName: string | undefined = commentAuthor?.["name"];

  if (!userEmail) {
    const creator = fullIssue.creator;
    if (creator) {
      userEmail = creator.email;
      userName = userName ?? creator.name;
    }
  }
  if (!userEmail) {
    const assignee = fullIssue.assignee;
    if (assignee) {
      userEmail = assignee.email;
      userName = userName ?? assignee.name;
    }
  }

  const title = fullIssue.title ?? "No title";
  const description = fullIssue.description ?? "No description";
  const imageUrls: string[] = extractImageUrls(description);

  const comments: LinearComment[] = fullIssue.comments?.nodes ?? [];
  const triggeringComment = (issueData["triggering_comment"] as string | undefined) ?? "";

  const commentIds = new Set<string>(comments.map((c) => c.id ?? "").filter(Boolean));
  const commentIdToIndex = new Map<string, number>(
    comments.map((c, i) => [c.id ?? "", i] as [string, number]),
  );

  let commentsText = "";
  if (comments.length) {
    let relevantComments: LinearComment[];
    if (triggeringCommentId) {
      const triggerIndex = commentIdToIndex.get(triggeringCommentId);
      relevantComments = triggerIndex !== undefined ? comments.slice(triggerIndex) : getRecentComments(comments, GITHUB_BOT_MESSAGE_PREFIXES) ?? [];
    } else {
      relevantComments = getRecentComments(comments, GITHUB_BOT_MESSAGE_PREFIXES) ?? [];
    }

    if (relevantComments.length) {
      commentsText = "\n\n## Comments:\n";
      for (const comment of relevantComments) {
        const user = comment.user ?? {};
        const author = user.name ?? "User";
        const body = comment.body ?? "";
        const bodyImageUrls = extractImageUrls(body);
        imageUrls.push(...bodyImageUrls);
        if (GITHUB_BOT_MESSAGE_PREFIXES.some((p) => body.startsWith(p))) continue;
        commentsText += `\n**${author}:** ${body}\n`;
      }
    }
  }

  if (triggeringComment && !commentIds.has(triggeringCommentId)) {
    if (!commentsText) commentsText = "\n\n## Comments:\n";
    const triggerAuthor = commentAuthor?.["name"] ?? "Unknown";
    const triggerImageUrls = extractImageUrls(triggeringComment);
    imageUrls.push(...triggerImageUrls);
    commentsText += `\n**${triggerAuthor}:** ${triggeringComment}\n`;
  }

  const identifier =
    (fullIssue.identifier as string | undefined) ??
    (issueData["identifier"] as string | undefined) ??
    "";
  const triggeredByLine = userName ? `## Triggered by: ${userName}\n\n` : "";
  const tagInstruction = userName
    ? `When calling linear_comment, tag @${userName} if you are asking them a question, need their input, or are notifying them of something important (e.g. a completed PR). For simple answers, tagging is not required.`
    : "";

  const prompt =
    `Please work on the following issue:\n\n` +
    `## Title: ${title}\n\n` +
    `${triggeredByLine}` +
    `## Linear Ticket: ${identifier} - Ticket ID: ${issueId}\n\n` +
    `## Description:\n${description}\n` +
    `${commentsText}\n\n` +
    `Please analyze this issue and implement the necessary changes. ` +
    `When you're done, commit and push your changes. ${tagInstruction}`;

  const contentBlocks: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];

  const deduped = dedupeUrls(imageUrls);
  for (const imageUrl of deduped) {
    const block = await fetchImageBlock(imageUrl);
    if (block) contentBlocks.push(block as unknown as Record<string, unknown>);
  }

  let linearProjectId = "";
  let linearIssueNumber = "";
  if (identifier.includes("-")) {
    const parts = identifier.split("-", 2) as [string, string];
    linearProjectId = parts[0];
    linearIssueNumber = parts[1];
  }

  const configurable = {
    repo: repoConfig,
    linear_issue: {
      id: issueId,
      title,
      url: (fullIssue.url as string | undefined) ?? (issueData["url"] as string | undefined) ?? "",
      identifier,
      linear_project_id: linearProjectId,
      linear_issue_number: linearIssueNumber,
      triggering_user_name: userName ?? "",
    },
    user_email: userEmail ?? "",
    source: "linear",
  };

  const threadActive = await isThreadActive(threadId);

  if (threadActive) {
    const queued = await queueMessageForThread(threadId, { text: prompt, image_urls: deduped });
    if (queued) {
      const client = getLangGraphClient();
      const runs = await client.runs.list(threadId, { limit: 1 });
      const firstRun = runs[0] as { run_id?: string } | undefined;
      if (firstRun?.run_id) {
        await postLinearTraceComment(issueId, firstRun.run_id, triggeringCommentId);
      }
    }
  } else {
    const client = getLangGraphClient();
    const run = await client.runs.create(
      threadId,
      "agent",
      {
        input: { messages: [{ role: "user", content: contentBlocks }] },
        metadata: config.agentVersionMetadata,
        config: { configurable },
        ifNotExists: "create",
      },
    );
    const runId = (run as { run_id?: string }).run_id ?? "";
    await postLinearTraceComment(issueId, runId, triggeringCommentId);
  }
}

// POST /webhooks/linear
app.post("/", async (c) => {
  const bodyBytes = Buffer.from(await c.req.arrayBuffer());
  const signature = c.req.header("Linear-Signature") ?? "";

  if (!verifyLinearSignature(bodyBytes, signature, config.linearWebhookSecret)) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(bodyBytes.toString("utf-8"));
  } catch {
    return c.json({ status: "error", message: "Invalid JSON" });
  }

  if (payload["type"] !== "Comment") {
    return c.json({ status: "ignored", reason: "Not a Comment event" });
  }

  if (payload["action"] !== "create") {
    return c.json({ status: "ignored", reason: `Comment action is '${payload["action"]}', only processing 'create'` });
  }

  const data = (payload["data"] as Record<string, unknown> | undefined) ?? {};

  if (data["botActor"]) {
    return c.json({ status: "ignored", reason: "Comment is from a bot" });
  }

  const commentBody = (data["body"] as string | undefined) ?? "";
  for (const prefix of GITHUB_BOT_MESSAGE_PREFIXES) {
    if (commentBody.startsWith(prefix)) {
      return c.json({ status: "ignored", reason: "Comment is our own bot message" });
    }
  }
  if (!commentBody.toLowerCase().includes("@openswe")) {
    return c.json({ status: "ignored", reason: "Comment doesn't mention @openswe" });
  }

  const issue = (data["issue"] as Record<string, unknown> | undefined) ?? {};
  if (!issue || Object.keys(issue).length === 0) {
    return c.json({ status: "ignored", reason: "No issue data in comment" });
  }

  const issueId = (issue["id"] as string | undefined) ?? "";
  const fullIssue = await fetchLinearIssueDetails(issueId);
  const resolvedIssue = fullIssue ?? (issue as LinearIssueDetails);

  let repoConfig = extractRepoFromText(commentBody, config.defaultRepoOwner);

  if (!repoConfig) {
    const team = (resolvedIssue.team as Record<string, unknown> | undefined) ?? {};
    const project = (resolvedIssue.project as Record<string, unknown> | undefined) ?? null;
    const teamName = (team["name"] as string | undefined)?.trim() ?? "";
    const projectName = (project?.["name"] as string | undefined)?.trim() ?? "";
    repoConfig = getRepoConfigFromTeamMapping(
      teamName,
      projectName,
      config.defaultRepoOwner,
      config.defaultRepoName,
    );
  }

  if (!isRepoOrgAllowed(repoConfig)) {
    return c.json({ status: "ignored", reason: "Repository org not in allowlist" });
  }

  const enrichedIssue: Record<string, unknown> = { ...issue };
  enrichedIssue["triggering_comment"] = commentBody;
  enrichedIssue["triggering_comment_id"] = (data["id"] as string | undefined) ?? "";
  const commentUser = data["user"] as Record<string, unknown> | undefined;
  if (commentUser) enrichedIssue["comment_author"] = commentUser;

  // Fire and forget — respond immediately, process in background
  processLinearIssue(enrichedIssue, repoConfig).catch((err) =>
    console.error("Failed to process Linear issue:", err),
  );

  return c.json({
    status: "accepted",
    message: `Processing issue '${resolvedIssue.title}' for repo ${repoConfig.owner}/${repoConfig.name}`,
  });
});

// GET /webhooks/linear — verification endpoint
app.get("/", (c) => c.json({ status: "ok", message: "Linear webhook endpoint is active" }));

export { app as linearRoutes };
