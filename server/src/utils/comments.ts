/**
 * Comment utilities for Linear issue processing.
 * Ports agent/utils/comments.py to TypeScript.
 */

export interface LinearComment {
  id?: string;
  body?: string;
  createdAt?: string;
  user?: { id?: string; name?: string; email?: string };
}

/**
 * Return user comments since the last agent response.
 * Returns null if there are no relevant comments.
 */
export function getRecentComments(
  comments: LinearComment[],
  botMessagePrefixes: readonly string[],
): LinearComment[] | null {
  if (!comments.length) return null;

  const sorted = [...comments].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );

  const recentUserComments: LinearComment[] = [];
  for (const comment of sorted) {
    const body = comment.body ?? "";
    if (botMessagePrefixes.some((prefix) => body.startsWith(prefix))) break;
    recentUserComments.push(comment);
  }

  if (!recentUserComments.length) return null;
  recentUserComments.reverse();
  return recentUserComments;
}
