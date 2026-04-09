/**
 * GitHub webhook comment utilities.
 * Mirrors agent/utils/github_comments.py
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { GITHUB_USER_EMAIL_MAP } from "./githubUserEmailMap.js";

export const OPEN_SWE_TAGS = ["@openswe", "@open-swe", "@openswe-dev"] as const;
const UNTRUSTED_GITHUB_COMMENT_OPEN_TAG =
  "<dangerous-external-untrusted-users-comment>";
const UNTRUSTED_GITHUB_COMMENT_CLOSE_TAG =
  "</dangerous-external-untrusted-users-comment>";
const SANITIZED_UNTRUSTED_OPEN = "[blocked-untrusted-comment-tag-open]";
const SANITIZED_UNTRUSTED_CLOSE = "[blocked-untrusted-comment-tag-close]";

const REACTION_ENDPOINTS: Record<string, string> = {
  issue_comment:
    "https://api.github.com/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
  pull_request_review_comment:
    "https://api.github.com/repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
  pull_request_review:
    "https://api.github.com/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{comment_id}/reactions",
};

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Verify the GitHub webhook signature (X-Hub-Signature-256).
 */
export function verifyGithubSignature(
  body: Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!secret) {
    console.warn(
      "GITHUB_WEBHOOK_SECRET is not configured — rejecting webhook request",
    );
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Extract a UUID-formatted thread ID from a branch name.
 */
export function getThreadIdFromBranch(branchName: string): string | null {
  const match = branchName.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return match ? match[0] : null;
}

/**
 * Strip reserved trust wrapper tags from raw GitHub comment bodies.
 */
export function sanitizeGithubCommentBody(body: string): string {
  const sanitized = body
    .replaceAll(UNTRUSTED_GITHUB_COMMENT_OPEN_TAG, SANITIZED_UNTRUSTED_OPEN)
    .replaceAll(UNTRUSTED_GITHUB_COMMENT_CLOSE_TAG, SANITIZED_UNTRUSTED_CLOSE);
  if (sanitized !== body) {
    console.warn(
      "Sanitized reserved untrusted-comment tags from GitHub comment body",
    );
  }
  return sanitized;
}

/**
 * Format a GitHub comment body for prompt inclusion.
 */
export function formatGithubCommentBodyForPrompt(
  author: string,
  body: string,
): string {
  const sanitizedBody = sanitizeGithubCommentBody(body);
  if (author in GITHUB_USER_EMAIL_MAP) return sanitizedBody;

  return (
    `${UNTRUSTED_GITHUB_COMMENT_OPEN_TAG}\n` +
    `${sanitizedBody}\n` +
    `${UNTRUSTED_GITHUB_COMMENT_CLOSE_TAG}`
  );
}

/**
 * React to a GitHub comment with 👀.
 */
export async function reactToGithubComment(
  repoConfig: { owner: string; name: string },
  commentId: number,
  options: {
    eventType: string;
    token: string;
    pullNumber?: number;
    nodeId?: string;
  },
): Promise<boolean> {
  const { eventType, token, pullNumber, nodeId } = options;

  if (eventType === "pull_request_review") {
    return reactViaGraphql(nodeId, token);
  }

  const urlTemplate =
    REACTION_ENDPOINTS[eventType] ?? REACTION_ENDPOINTS.issue_comment;
  const url = urlTemplate
    .replace("{owner}", repoConfig.owner)
    .replace("{repo}", repoConfig.name)
    .replace("{comment_id}", String(commentId))
    .replace("{pull_number}", String(pullNumber ?? ""));

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "eyes" }),
    });
    return response.status === 200 || response.status === 201;
  } catch (err) {
    console.error(`Failed to react to GitHub comment ${commentId}:`, err);
    return false;
  }
}

async function reactViaGraphql(
  nodeId: string | undefined,
  token: string,
): Promise<boolean> {
  if (!nodeId) {
    console.warn("No node_id provided for GraphQL reaction");
    return false;
  }

  const query = `
    mutation AddReaction($subjectId: ID!) {
      addReaction(input: {subjectId: $subjectId, content: EYES}) {
        reaction { content }
      }
    }
  `;

  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { subjectId: nodeId } }),
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (data.errors) {
      console.warn("GraphQL reaction errors:", data.errors);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Failed to react via GraphQL for node_id ${nodeId}:`, err);
    return false;
  }
}

/**
 * Post a comment to a GitHub issue or PR.
 */
export async function postGithubCommentOnIssue(
  repoConfig: { owner: string; name: string },
  issueNumber: number,
  body: string,
  token: string,
): Promise<boolean> {
  const url = `https://api.github.com/repos/${repoConfig.owner}/${repoConfig.name}/issues/${issueNumber}/comments`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      console.error(
        `Failed to post comment to issue/PR #${issueNumber}: ${response.status}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `Failed to post comment to GitHub issue/PR #${issueNumber}:`,
      err,
    );
    return false;
  }
}

/**
 * Fetch all comments for a GitHub issue (paginated).
 */
export async function fetchIssueComments(
  repoConfig: { owner: string; name: string },
  issueNumber: number,
  token?: string,
): Promise<
  Array<{
    body: string;
    author: string;
    created_at: string;
    comment_id: number;
  }>
> {
  const url = `https://api.github.com/repos/${repoConfig.owner}/${repoConfig.name}/issues/${issueNumber}/comments`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const comments = await fetchPaginated(url, headers);
  return comments.map((c) => ({
    body: (c.body as string) ?? "",
    author: ((c.user as Record<string, unknown>)?.login as string) ?? "unknown",
    created_at: (c.created_at as string) ?? "",
    comment_id: c.id as number,
  }));
}

interface PrComment {
  body: string;
  author: string;
  created_at: string;
  type: string;
  comment_id: number;
  path?: string;
  line?: number;
}

/**
 * Fetch all PR comments/reviews since the last @open-swe tag.
 */
export async function fetchPrCommentsSinceLastTag(
  repoConfig: { owner: string; name: string },
  prNumber: number,
  token: string,
): Promise<PrComment[]> {
  const { owner, name } = repoConfig;
  const headers = githubHeaders(token);
  const base = `https://api.github.com/repos/${owner}/${name}`;

  const [prComments, reviewComments, reviews] = await Promise.all([
    fetchPaginated(`${base}/issues/${prNumber}/comments`, headers),
    fetchPaginated(`${base}/pulls/${prNumber}/comments`, headers),
    fetchPaginated(`${base}/pulls/${prNumber}/reviews`, headers),
  ]);

  const allComments: PrComment[] = [];

  for (const c of prComments) {
    allComments.push({
      body: (c.body as string) ?? "",
      author:
        ((c.user as Record<string, unknown>)?.login as string) ?? "unknown",
      created_at: (c.created_at as string) ?? "",
      type: "pr_comment",
      comment_id: c.id as number,
    });
  }

  for (const c of reviewComments) {
    allComments.push({
      body: (c.body as string) ?? "",
      author:
        ((c.user as Record<string, unknown>)?.login as string) ?? "unknown",
      created_at: (c.created_at as string) ?? "",
      type: "review_comment",
      comment_id: c.id as number,
      path: (c.path as string) ?? "",
      line: (c.line as number) ?? (c.original_line as number) ?? undefined,
    });
  }

  for (const r of reviews) {
    const body = (r.body as string) ?? "";
    if (!body) continue;
    allComments.push({
      body,
      author:
        ((r.user as Record<string, unknown>)?.login as string) ?? "unknown",
      created_at: (r.submitted_at as string) ?? "",
      type: "review",
      comment_id: r.id as number,
    });
  }

  allComments.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const tagIndices: number[] = [];
  for (let i = 0; i < allComments.length; i++) {
    const bodyLower = (allComments[i].body ?? "").toLowerCase();
    if (OPEN_SWE_TAGS.some((tag) => bodyLower.includes(tag))) {
      tagIndices.push(i);
    }
  }

  if (tagIndices.length === 0) return [];

  const start =
    tagIndices.length === 1 ? 0 : tagIndices[tagIndices.length - 2] + 1;
  return allComments.slice(start);
}

/**
 * Fetch the head branch name of a PR.
 */
export async function fetchPrBranch(
  repoConfig: { owner: string; name: string },
  prNumber: number,
  token?: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoConfig.owner}/${repoConfig.name}/pulls/${prNumber}`,
      { headers },
    );
    if (response.status === 200) {
      const data = (await response.json()) as Record<string, unknown>;
      return ((data.head as Record<string, unknown>)?.ref as string) ?? "";
    }
  } catch (err) {
    console.error(`Failed to fetch branch for PR ${prNumber}:`, err);
  }
  return "";
}

/**
 * Extract key fields from a GitHub PR webhook payload.
 */
export async function extractPrContext(
  payload: Record<string, unknown>,
  eventType: string,
): Promise<{
  repoConfig: { owner: string; name: string };
  prNumber: number | null;
  branchName: string;
  githubLogin: string;
  prUrl: string;
  commentId: number | null;
  nodeId: string | null;
  baseBranch: string;
}> {
  const repoData = (payload.repository ?? {}) as Record<string, unknown>;
  const repoConfig = {
    owner: ((repoData.owner as Record<string, unknown>)?.login as string) ?? "",
    name: (repoData.name as string) ?? "",
  };

  const prData = (payload.pull_request ?? payload.issue ?? {}) as Record<
    string,
    unknown
  >;
  const prNumber = (prData.number as number) ?? null;
  const prUrl = (prData.html_url as string) ?? (prData.url as string) ?? "";
  let branchName =
    ((
      (payload.pull_request as Record<string, unknown>)?.head as Record<
        string,
        unknown
      >
    )?.ref as string) ?? "";
  const baseBranch =
    ((
      (payload.pull_request as Record<string, unknown>)?.base as Record<
        string,
        unknown
      >
    )?.ref as string) ?? "";

  if (!branchName && prNumber) {
    branchName = await fetchPrBranch(repoConfig, prNumber);
  }

  const githubLogin =
    ((payload.sender as Record<string, unknown>)?.login as string) ?? "";
  const comment = (payload.comment ?? payload.review ?? {}) as Record<
    string,
    unknown
  >;
  const commentId = (comment.id as number) ?? null;
  const nodeId =
    eventType === "pull_request_review"
      ? ((comment.node_id as string) ?? null)
      : null;

  return {
    repoConfig,
    prNumber,
    branchName,
    githubLogin,
    prUrl,
    commentId,
    nodeId,
    baseBranch,
  };
}

/**
 * Format PR comments into a human message for the agent.
 */
export function buildPrPrompt(comments: PrComment[], prUrl: string): string {
  const lines: string[] = [];
  for (const c of comments) {
    const body = formatGithubCommentBodyForPrompt(c.author, c.body);
    if (c.type === "review_comment") {
      const path = c.path ?? "";
      const line = c.line ?? "";
      const loc = path ? ` (file: \`${path}\`, line: ${line})` : "";
      lines.push(`\n**${c.author}**${loc}:\n${body}\n`);
    } else {
      lines.push(`\n**${c.author}**:\n${body}\n`);
    }
  }

  const commentsText = lines.join("");
  return `You've been tagged in GitHub PR comments. Please resolve them.\n\nPR: ${prUrl}\n\n## Comments:\n${commentsText}\n\nIf code changes are needed:\n1. Make the changes in the sandbox\n2. Call \`commit_and_open_pr\` to push them to GitHub — this is REQUIRED, do NOT skip it\n3. Call \`github_comment\` with the PR number to post a summary on GitHub\n\nIf no code changes are needed:\n1. Call \`github_comment\` with the PR number to explain your answer — this is REQUIRED, never end silently\n\n**You MUST always call \`github_comment\` before finishing — whether or not changes were made.**`;
}

async function fetchPaginated(
  url: string,
  headers: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  let page = 1;

  while (true) {
    try {
      const sep = url.includes("?") ? "&" : "?";
      const response = await fetch(`${url}${sep}per_page=100&page=${page}`, {
        headers,
      });
      if (response.status !== 200) break;
      const data = (await response.json()) as Array<Record<string, unknown>>;
      if (!data.length) break;
      results.push(...data);
      if (data.length < 100) break;
      page++;
    } catch (err) {
      console.error(`Failed to fetch ${url}:`, err);
      break;
    }
  }

  return results;
}
