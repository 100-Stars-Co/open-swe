/**
 * Utilities for extracting repository configuration from text.
 * Mirrors agent/utils/repo.py
 */

const DEFAULT_REPO_OWNER = process.env.DEFAULT_REPO_OWNER ?? "langchain-ai";

/**
 * Extract owner/name repo config from text containing `repo:owner/name` or GitHub URLs.
 *
 * Returns an object with `owner` and `name` keys, or `null` if no repo found.
 */
export function extractRepoFromTextFull(
  text: string,
  defaultOwner?: string,
): { owner: string; name: string } | null {
  const resolvedDefault = defaultOwner ?? DEFAULT_REPO_OWNER;
  let owner: string | undefined;
  let name: string | undefined;

  if (text.includes("repo:") || text.includes("repo ")) {
    const match = text.match(/repo[: ]([a-zA-Z0-9_.\-/]+)/);
    if (match) {
      const value = match[1].replace(/\/+$/, "");
      if (value.includes("/")) {
        [owner, name] = value.split("/", 2);
      } else {
        owner = resolvedDefault;
        name = value;
      }
    }
  }

  if (!owner || !name) {
    const githubMatch = text.match(
      /github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/,
    );
    if (githubMatch) {
      [owner, name] = githubMatch[1].split("/", 2);
    }
  }

  if (owner && name) return { owner, name };
  return null;
}
