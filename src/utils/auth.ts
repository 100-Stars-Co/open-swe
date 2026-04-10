/**
 * GitHub token resolution and encrypted persistence.
 * Mirrors agent/utils/auth.py and agent/utils/github_token.py
 */

import { Client } from "@langchain/langgraph-sdk";
import { decryptToken, encryptToken } from "../encryption.js";
import { getInstallationToken } from "./githubApp.js";

const THREAD_METADATA_KEY = "github_token_encrypted";

export function getGithubTokenFromEnv(): string | null {
  const token =
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_PAT?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    "";
  return token || null;
}

export function isEphemeralGithubToken(token: string): boolean {
  return token.startsWith("ghs_");
}

export function shouldPersistGithubToken(token: string): boolean {
  return !isEphemeralGithubToken(token);
}

/**
 * Resolve a GitHub token for a given run config + thread.
 *
 * Priority:
 *   1. Decrypted token from thread metadata (durable PAT / OAuth token)
 *   2. Explicit env token override (GITHUB_TOKEN / GITHUB_PAT / GH_TOKEN)
 *   3. GitHub App installation token (env-based, short-lived, not persisted)
 *
 * Returns [token, encryptedToken | null]
 * encryptedToken is non-null when a new token was just fetched and should be persisted.
 */
export async function resolveGithubToken(
  _config: Record<string, unknown>,
  threadId: string,
): Promise<[string, string | null]> {
  // 1. Try thread metadata
  try {
    const client = getLangGraphClient();
    const thread = await client.threads.get(threadId);
    const metadata = (thread?.metadata ?? {}) as Record<string, unknown>;
    const encrypted = metadata[THREAD_METADATA_KEY] as string | undefined;
    if (encrypted) {
      const token = decryptToken(encrypted);
      if (token && shouldPersistGithubToken(token)) return [token, null];
    }
  } catch {
    // Thread may not exist yet — continue to fallback
  }

  // 2. Explicit env override for private repo access
  const envToken = getGithubTokenFromEnv();
  if (envToken) {
    return [envToken, encryptToken(envToken)];
  }

  // 3. Fall back to GitHub App installation token
  const token = await getInstallationToken();
  if (token) {
    return [token, null];
  }

  throw new Error(
    "Could not resolve a GitHub token. " +
      "Configure GITHUB_TOKEN, GITHUB_PAT, or GH_TOKEN for private repo access, " +
      "configure GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID, " +
      "or provide a personal access token.",
  );
}

/**
 * Persist an encrypted GitHub token into LangGraph thread metadata.
 */
export async function persistEncryptedGithubToken(
  threadId: string,
  encryptedToken: string,
): Promise<void> {
  const client = getLangGraphClient();
  await client.threads.update(threadId, {
    metadata: { [THREAD_METADATA_KEY]: encryptedToken },
  });
}

function getLangGraphClient(): Client {
  return new Client({
    apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024",
  });
}
