/**
 * Helpers for extracting repo / branch context from webhook payloads.
 * Mirrors agent/utils/extract.py
 */

/**
 * Parse "owner/repo" from a string, e.g. extracted from an @mention comment body.
 * Returns [owner, repo] or null if not found.
 */
export function extractRepoFromText(text: string): [string, string] | null {
  const match = text.match(/\brepo:\s*([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\b/);
  if (!match) return null;
  return [match[1], match[2]];
}

/**
 * Parse a branch name from comment text, e.g. "branch: main" or "base: develop".
 * Returns the branch name or null.
 */
export function extractBranchFromText(text: string): string | null {
  const match = text.match(/\b(?:branch|base):\s*([a-zA-Z0-9/_.-]+)\b/i);
  return match ? match[1] : null;
}

/**
 * Generate a safe git branch name from an issue title + number.
 * e.g. "Fix login bug" + 42 → "open-swe/issue-42-fix-login-bug"
 */
export function generateBranchName(issueTitle: string, issueNumber: number | string): string {
  const slug = issueTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `open-swe/issue-${issueNumber}-${slug}`;
}
