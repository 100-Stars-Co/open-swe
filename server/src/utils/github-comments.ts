/**
 * GitHub webhook signature verification and comment utilities.
 * Ports agent/utils/github_comments.py to TypeScript.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { RepoConfig } from "./config.ts";
import { GITHUB_USER_EMAIL_MAP } from "../constants/github-user-email-map.ts";

export const OPEN_SWE_TAGS = ["@openswe", "@open-swe", "@openswe-dev"] as const;
const UNTRUSTED_OPEN_TAG = "<dangerous-external-untrusted-users-comment>";
const UNTRUSTED_CLOSE_TAG = "</dangerous-external-untrusted-users-comment>";
const SANITIZED_OPEN_TAG = "[blocked-untrusted-comment-tag-open]";
const SANITIZED_CLOSE_TAG = "[blocked-untrusted-comment-tag-close]";

/** Verify the GitHub webhook HMAC-SHA256 signature. */
export function verifyGithubSignature(body: Buffer, signature: string, secret: string): boolean {
  if (!secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Extract a UUID thread ID from an open-swe branch name (e.g. openswe/abc123/.../uuid). */
export function getThreadIdFromBranch(branchName: string): string | null {
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(branchName);
  return match ? match[0] : null;
}

/** Strip reserved trust wrapper tags from a raw GitHub comment body. */
export function sanitizeGithubCommentBody(body: string): string {
  return body.replaceAll(UNTRUSTED_OPEN_TAG, SANITIZED_OPEN_TAG).replaceAll(
    UNTRUSTED_CLOSE_TAG,
    SANITIZED_CLOSE_TAG,
  );
}

/** Format a GitHub comment body for prompt inclusion (wraps untrusted authors). */
export function formatGithubCommentBodyForPrompt(author: string, body: string): string {
  const sanitized = sanitizeGithubCommentBody(body);
  if (author in GITHUB_USER_EMAIL_MAP) return sanitized;
  return `${UNTRUSTED_OPEN_TAG}\n${sanitized}\n${UNTRUSTED_CLOSE_TAG}`;
}

const REACTION_ENDPOINTS: Record<string, string> = {
  issue_comment:
    "https://api.github.com/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
  pull_request_review_comment:
    "https://api.github.com/repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
  pull_request_review:
    "https://api.github.com/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{comment_id}/reactions",
};

/** Add a 👀 reaction to a GitHub comment. */
export async function reactToGithubComment(
  repoConfig: RepoConfig,
  commentId: number,
  opts: { eventType: string; token: string; pullNumber?: number | null; nodeId?: string | null },
): Promise<boolean> {
  if (opts.eventType === "pull_request_review") {
    return reactViaGraphql(opts.nodeId ?? null, opts.token);
  }

  const urlTemplate =
    REACTION_ENDPOINTS[opts.eventType] ?? (REACTION_ENDPOINTS["issue_comment"] as string);
  const url = urlTemplate
    .replace("{owner}", repoConfig.owner)
    .replace("{repo}", repoConfig.name)
    .replace("{comment_id}", String(commentId))
    .replace("{pull_number}", String(opts.pullNumber ?? ""));

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "eyes" }),
    });
    return response.status === 200 || response.status === 201;
  } catch {
    return false;
  }
}

async function reactViaGraphql(nodeId: string | null, token: string): Promise<boolean> {
  if (!nodeId) return false;
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
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { subjectId: nodeId } }),
    });
    const data = (await response.json()) as { errors?: unknown };
    return !data.errors;
  } catch {
    return false;
  }
}

export interface GithubComment {
  body: string;
  author: string;
  created_at: string;
  comment_id?: number;
  type?: string;
  path?: string;
  line?: number | null;
}

interface GhApiItem {
  id?: number;
  body?: string;
  user?: { login?: string };
  created_at?: string;
  submitted_at?: string;
  path?: string;
  line?: number;
  original_line?: number;
}

/** Fetch all comments for a GitHub issue (paginated). */
export async function fetchIssueComments(
  repoConfig: RepoConfig,
  issueNumber: number,
  token?: string | null,
): Promise<GithubComment[]> {
  const { owner, name } = repoConfig;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const raw = await fetchPaginated(
    `https://api.github.com/repos/${owner}/${name}/issues/${issueNumber}/comments`,
    headers,
  );
  return raw.map((c) => ({
    body: c.body ?? "",
    author: c.user?.login ?? "unknown",
    created_at: c.created_at ?? "",
    comment_id: c.id,
  }));
}

/** Fetch all PR comments/reviews/inline-review-comments since the last @open-swe tag. */
export async function fetchPrCommentsSinceLastTag(
  repoConfig: RepoConfig,
  prNumber: number,
  token: string,
): Promise<GithubComment[]> {
  const { owner, name } = repoConfig;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const [prComments, reviewComments, reviews] = await Promise.all([
    fetchPaginated(
      `https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/comments`,
      headers,
    ),
    fetchPaginated(
      `https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}/comments`,
      headers,
    ),
    fetchPaginated(
      `https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}/reviews`,
      headers,
    ),
  ]);

  const allComments: GithubComment[] = [];

  for (const c of prComments) {
    allComments.push({
      body: c.body ?? "",
      author: c.user?.login ?? "unknown",
      created_at: c.created_at ?? "",
      type: "pr_comment",
      comment_id: c.id,
    });
  }
  for (const c of reviewComments) {
    allComments.push({
      body: c.body ?? "",
      author: c.user?.login ?? "unknown",
      created_at: c.created_at ?? "",
      type: "review_comment",
      comment_id: c.id,
      path: c.path ?? "",
      line: c.line ?? c.original_line ?? null,
    });
  }
  for (const r of reviews) {
    const body: string = r.body ?? "";
    if (!body) continue;
    allComments.push({
      body,
      author: r.user?.login ?? "unknown",
      created_at: r.submitted_at ?? "",
      type: "review",
      comment_id: r.id,
    });
  }

  allComments.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const tagIndices = allComments
    .map((c, i) =>
      OPEN_SWE_TAGS.some((tag) => (c.body ?? "").toLowerCase().includes(tag)) ? i : -1,
    )
    .filter((i) => i >= 0);

  if (!tagIndices.length) return [];

  const start = tagIndices.length === 1 ? 0 : (tagIndices[tagIndices.length - 2] as number) + 1;
  return allComments.slice(start);
}

/** Fetch the head branch name for a PR. */
export async function fetchPrBranch(
  repoConfig: RepoConfig,
  prNumber: number,
  token?: string | null,
): Promise<string> {
  const { owner, name } = repoConfig;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}`,
      { headers },
    );
    if (response.status === 200) {
      const data = (await response.json()) as { head?: { ref?: string } };
      return data.head?.ref ?? "";
    }
  } catch {
    // ignore
  }
  return "";
}

/** Build the user prompt for PR comments. */
export function buildPrPrompt(comments: GithubComment[], prUrl: string): string {
  const lines = comments.map((c) => {
    const body = formatGithubCommentBodyForPrompt(c.author, c.body);
    if (c.type === "review_comment") {
      const loc = c.path ? ` (file: \`${c.path}\`, line: ${c.line})` : "";
      return `\n**${c.author}**${loc}:\n${body}\n`;
    }
    return `\n**${c.author}**:\n${body}\n`;
  });

  return (
    "You've been tagged in GitHub PR comments. Please resolve them.\n\n" +
    `PR: ${prUrl}\n\n` +
    `## Comments:\n${lines.join("")}\n\n` +
    "If code changes are needed:\n" +
    "1. Make the changes in the sandbox\n" +
    "2. Call `commit_and_open_pr` to push them to GitHub — this is REQUIRED, do NOT skip it\n" +
    "3. Call `github_comment` with the PR number to post a summary on GitHub\n\n" +
    "If no code changes are needed:\n" +
    "1. Call `github_comment` with the PR number to explain your answer — this is REQUIRED, never end silently\n\n" +
    "**You MUST always call `github_comment` before finishing — whether or not changes were made.**"
  );
}

/** Paginated GitHub API fetch. */
async function fetchPaginated(url: string, headers: Record<string, string>): Promise<GhApiItem[]> {
  const results: GhApiItem[] = [];
  let page = 1;
  while (true) {
    const u = new URL(url);
    u.searchParams.set("per_page", "100");
    u.searchParams.set("page", String(page));
    try {
      const response = await fetch(u.toString(), { headers });
      if (response.status !== 200) break;
      const data = (await response.json()) as GhApiItem[];
      if (!data.length) break;
      results.push(...data);
      if (data.length < 100) break;
      page++;
    } catch {
      break;
    }
  }
  return results;
}
