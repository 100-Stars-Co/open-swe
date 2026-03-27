/**
 * Repository configuration extraction from text.
 * Ports agent/utils/repo.py to TypeScript.
 */

import type { RepoConfig } from "./config.ts";
import { config } from "./config.ts";

/**
 * Extract owner/name repo config from text containing repo: syntax or GitHub URLs.
 * Returns null if no repo is found.
 */
export function extractRepoFromText(
  text: string,
  defaultOwner: string = config.defaultRepoOwner,
): RepoConfig | null {
  let owner: string | null = null;
  let name: string | null = null;

  if (text.includes("repo:") || text.includes("repo ")) {
    const match = /repo[: ]([a-zA-Z0-9_.\-/]+)/.exec(text);
    if (match?.[1]) {
      const value = match[1].replace(/\/$/, "");
      if (value.includes("/")) {
        const [o, n] = value.split("/", 2) as [string, string];
        owner = o;
        name = n;
      } else {
        owner = defaultOwner;
        name = value;
      }
    }
  }

  if (!owner || !name) {
    const ghMatch = /github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/.exec(text);
    if (ghMatch?.[1]) {
      const [o, n] = ghMatch[1].split("/", 2) as [string, string];
      owner = o;
      name = n;
    }
  }

  if (owner && name) return { owner, name };
  return null;
}
