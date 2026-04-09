/**
 * Jira webhook payload parsing and thread ID generation.
 * Mirrors agent/utils/jira_webhook.py
 */

import { createHash } from "node:crypto";

export interface JiraIssueContext {
  issueKey: string;
  issueSummary: string;
  issueDescription: string;
  projectKey: string;
  reporterEmail: string;
  reporterDisplayName: string;
  threadId: string;
  repoOwner: string;
  repoName: string;
}

export interface JiraCommentContext {
  issueKey: string;
  commentBody: string;
  authorEmail: string;
  authorDisplayName: string;
  threadId: string;
  repoOwner: string;
  repoName: string;
}

/**
 * Generate a deterministic UUIDv4-formatted thread ID from a Jira issue key.
 */
export function generateThreadIdFromJiraIssue(issueKey: string): string {
  const baseUrl = process.env.JIRA_BASE_URL ?? "";
  const hash = createHash("sha256")
    .update(`${baseUrl}:${issueKey}`)
    .digest("hex");
  return formatAsUuid(hash);
}

/** Format first 32 hex chars as UUID v4 string. */
function formatAsUuid(hex: string): string {
  const h = hex.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "4" + h.slice(13, 16), // version 4
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20), // variant
    h.slice(20, 32),
  ].join("-");
}

/**
 * Parse a `jira:issue_created` webhook payload.
 */
export function parseJiraIssuePayload(
  // biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped
  payload: Record<string, any>,
): JiraIssueContext | null {
  const issue = payload.issue;
  if (!issue) return null;

  const fields = issue.fields ?? {};
  const issueKey = issue.key as string;
  const issueSummary = (fields.summary as string) ?? "";
  const description = fields.description;
  let issueDescription = "";
  if (typeof description === "string") {
    issueDescription = description;
  } else if (description?.content) {
    issueDescription = extractAtlassianDocText(description);
  }

  const projectKey = (fields.project?.key as string) ?? "";
  const reporter = fields.reporter ?? {};
  const reporterEmail = (reporter.emailAddress as string) ?? "";
  const reporterDisplayName = (reporter.displayName as string) ?? "";

  const threadId = generateThreadIdFromJiraIssue(issueKey);
  const repoOwner = process.env.DEFAULT_REPO_OWNER ?? "";
  const repoName = process.env.DEFAULT_REPO_NAME ?? "";

  return {
    issueKey,
    issueSummary,
    issueDescription,
    projectKey,
    reporterEmail,
    reporterDisplayName,
    threadId,
    repoOwner,
    repoName,
  };
}

/**
 * Parse a `comment_created` webhook payload.
 */
export function parseJiraCommentPayload(
  // biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped
  payload: Record<string, any>,
): JiraCommentContext | null {
  const issue = payload.issue;
  const comment = payload.comment;
  if (!issue || !comment) return null;

  const issueKey = issue.key as string;
  const body = comment.body;
  let commentBody = "";
  if (typeof body === "string") {
    commentBody = body;
  } else if (body?.content) {
    commentBody = extractAtlassianDocText(body);
  }

  const author = comment.author ?? {};
  const authorEmail = (author.emailAddress as string) ?? "";
  const authorDisplayName = (author.displayName as string) ?? "";

  const threadId = generateThreadIdFromJiraIssue(issueKey);
  const repoOwner = process.env.DEFAULT_REPO_OWNER ?? "";
  const repoName = process.env.DEFAULT_REPO_NAME ?? "";

  return {
    issueKey,
    commentBody,
    authorEmail,
    authorDisplayName,
    threadId,
    repoOwner,
    repoName,
  };
}

/**
 * Extract plain text from an Atlassian Document Format (ADF) node.
 */
// biome-ignore lint/suspicious/noExplicitAny: ADF nodes are untyped
function extractAtlassianDocText(node: Record<string, any>): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return (node.text as string) ?? "";
  // biome-ignore lint/suspicious/noExplicitAny: ADF nodes are untyped
  const children = (node.content as Record<string, any>[]) ?? [];
  return children.map(extractAtlassianDocText).join("");
}
