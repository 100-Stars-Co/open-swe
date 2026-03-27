/**
 * Linear GraphQL API utilities.
 * Ports agent/utils/linear.py and relevant parts of agent/webapp.py to TypeScript.
 */

import { config } from "./config.ts";
import { getTraceUrl } from "./tracing.ts";

const LINEAR_API_URL = "https://api.linear.app/graphql";

function linearHeaders(): Record<string, string> {
  return {
    Authorization: config.linearApiKey,
    "Content-Type": "application/json",
  };
}

async function graphqlRequest(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (!config.linearApiKey) return { error: "LINEAR_API_KEY is not set" };
  try {
    const response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: linearHeaders(),
      body: JSON.stringify({ query, variables }),
    });
    const result = (await response.json()) as { errors?: unknown; data?: Record<string, unknown> };
    if (result.errors) return { error: result.errors };
    return result.data ?? {};
  } catch (err) {
    return { error: String(err) };
  }
}

/** Add a reaction to a Linear comment. */
export async function reactToLinearComment(commentId: string, emoji = "👀"): Promise<boolean> {
  if (!config.linearApiKey) return false;
  const mutation = `
    mutation ReactionCreate($commentId: String!, $emoji: String!) {
      reactionCreate(input: { commentId: $commentId, emoji: $emoji }) {
        success
      }
    }
  `;
  const result = await graphqlRequest(mutation, { commentId, emoji });
  const rc = result["reactionCreate"];
  return typeof rc === "object" && rc !== null && Boolean((rc as Record<string, unknown>)["success"]);
}

export interface LinearIssueDetails {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  project?: { id?: string; name?: string };
  team?: { id?: string; name?: string; key?: string };
  creator?: { id?: string; name?: string; email?: string };
  assignee?: { id?: string; name?: string; email?: string };
  comments?: { nodes?: LinearComment[] };
}

export interface LinearComment {
  id?: string;
  body?: string;
  createdAt?: string;
  user?: { id?: string; name?: string; email?: string };
}

/** Fetch full issue details from Linear API. */
export async function fetchLinearIssueDetails(issueId: string): Promise<LinearIssueDetails | null> {
  if (!config.linearApiKey) return null;
  const query = `
    query GetIssue($issueId: String!) {
      issue(id: $issueId) {
        id identifier title description url
        project { id name }
        team { id name key }
        creator { id name email }
        assignee { id name email }
        comments { nodes { id body createdAt user { id name email } } }
      }
    }
  `;
  const result = await graphqlRequest(query, { issueId });
  const issue = result["issue"];
  return typeof issue === "object" && issue !== null ? (issue as LinearIssueDetails) : null;
}

/** Add a comment to a Linear issue. */
export async function commentOnLinearIssue(
  issueId: string,
  body: string,
  parentId?: string | null,
): Promise<boolean> {
  const mutation = `
    mutation CommentCreate($issueId: String!, $body: String!, $parentId: String) {
      commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) {
        success
        comment { id }
      }
    }
  `;
  const result = await graphqlRequest(mutation, { issueId, body, parentId: parentId ?? null });
  const cc = result["commentCreate"];
  return typeof cc === "object" && cc !== null && Boolean((cc as Record<string, unknown>)["success"]);
}

/** Post a Langfuse trace URL comment on a Linear issue. */
export async function postLinearTraceComment(
  issueId: string,
  runId: string,
  triggeringCommentId: string,
): Promise<void> {
  const traceUrl = getTraceUrl(runId);
  if (traceUrl) {
    await commentOnLinearIssue(
      issueId,
      `On it! [View trace](${traceUrl})`,
      triggeringCommentId || null,
    );
  }
}
