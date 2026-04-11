import { decryptToken, encryptToken } from "../encryption.js";
import { getAgentStateStore } from "../state/index.js";
import { getInstallationToken } from "./githubApp.js";

const THREAD_METADATA_KEY = "githubTokenEncrypted";

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

export async function resolveGithubToken(
  _config: Record<string, unknown>,
  threadId: string,
): Promise<[string, string | null]> {
  const thread = await getAgentStateStore().getThread(threadId);
  const encrypted = thread?.metadata?.githubTokenEncrypted;
  if (encrypted) {
    const token = decryptToken(encrypted);
    if (token && shouldPersistGithubToken(token)) return [token, null];
  }

  const envToken = getGithubTokenFromEnv();
  if (envToken) {
    return [envToken, encryptToken(envToken)];
  }

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

export async function persistEncryptedGithubToken(
  threadId: string,
  encryptedToken: string,
): Promise<void> {
  await getAgentStateStore().updateThread(threadId, {
    metadata: { [THREAD_METADATA_KEY]: encryptedToken },
  });
}
