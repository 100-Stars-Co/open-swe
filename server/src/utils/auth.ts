/**
 * GitHub token management.
 * Ports agent/utils/auth.py (the webapp-facing parts) to TypeScript.
 */

import { getLangGraphClient } from "./langgraph.ts";
import { encryptToken } from "./crypto.ts";
import { getGithubAppInstallationToken } from "./github-app.ts";

/** Encrypt a GitHub token and store it on the thread metadata. */
export async function persistEncryptedGithubToken(
  threadId: string,
  token: string,
): Promise<void> {
  const encrypted = encryptToken(token);
  const client = getLangGraphClient();
  await client.threads.update(threadId, { metadata: { github_token_encrypted: encrypted } });
}

/**
 * Resolve a GitHub App installation token and persist it for a thread.
 * Returns the token string or null if unavailable.
 */
export async function getOrResolveThreadGithubToken(threadId: string): Promise<string | null> {
  const botToken = await getGithubAppInstallationToken();
  if (botToken) {
    try {
      await persistEncryptedGithubToken(threadId, botToken);
    } catch {
      console.warn("Could not persist bot token for thread", threadId);
    }
    return botToken;
  }
  console.warn("GitHub App token unavailable for thread", threadId);
  return null;
}
