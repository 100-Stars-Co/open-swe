/**
 * Helpers for collaborative commit and PR attribution.
 * Mirrors agent/utils/authorship.py
 */

import { GITHUB_USER_EMAIL_MAP } from "./githubUserEmailMap.js";

const OPEN_SWE_BOT_NAME = "open-swe[bot]";
const OPEN_SWE_BOT_EMAIL = "open-swe@users.noreply.github.com";

export interface CollaboratorIdentity {
  displayName: string;
  commitName: string;
  commitEmail: string;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function githubNoreplyEmail(login: string, userId?: unknown): string {
  const normalizedLogin = normalizeText(login);
  if (!normalizedLogin) return "";

  const normalizedUserId = userId !== undefined && userId !== null ? String(userId).trim() : "";
  if (normalizedUserId) {
    return `${normalizedUserId}+${normalizedLogin}@users.noreply.github.com`;
  }
  return `${normalizedLogin}@users.noreply.github.com`;
}

async function identityFromGithubToken(
  githubToken: string | undefined | null,
): Promise<CollaboratorIdentity | null> {
  if (!githubToken) return null;

  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (response.status !== 200) return null;

    const payload = (await response.json()) as Record<string, unknown>;
    const login = normalizeText(payload.login);
    const displayName = normalizeText(payload.name) || login;
    const commitEmail = githubNoreplyEmail(login, payload.id) || normalizeText(payload.email);

    if (!displayName || !commitEmail) return null;
    if (commitEmail === OPEN_SWE_BOT_EMAIL && displayName === OPEN_SWE_BOT_NAME) return null;

    return { displayName, commitName: displayName, commitEmail };
  } catch {
    return null;
  }
}

function identityFromConfig(config: Record<string, unknown>): CollaboratorIdentity | null {
  const configurable = (config.configurable ?? {}) as Record<string, unknown>;

  const githubLogin = normalizeText(configurable.github_login);
  if (githubLogin) {
    const githubUserId = configurable.github_user_id;
    const commitEmail =
      githubNoreplyEmail(githubLogin, githubUserId) ||
      normalizeText(GITHUB_USER_EMAIL_MAP[githubLogin]);
    if (commitEmail) {
      return { displayName: githubLogin, commitName: githubLogin, commitEmail };
    }
  }

  const telegramChat = (configurable.telegram_chat ?? {}) as Record<string, unknown>;

  const displayName =
    normalizeText(telegramChat.triggering_user_name) ||
    normalizeText(configurable.user_email).split("@")[0];

  const commitEmail =
    normalizeText(configurable.user_email) || normalizeText(telegramChat.triggering_user_email);

  if (displayName && commitEmail) {
    return { displayName, commitName: displayName, commitEmail };
  }
  return null;
}

/**
 * Resolve the triggering user's git identity.
 * Prefer the GitHub account identity derived from the token when available.
 */
export async function resolveTriggeringUserIdentity(
  config: Record<string, unknown>,
  githubToken?: string | null,
): Promise<CollaboratorIdentity | null> {
  return (await identityFromGithubToken(githubToken)) ?? identityFromConfig(config);
}

/**
 * Append a Co-authored-by trailer when a user identity is available.
 */
export function addUserCoauthorTrailer(
  commitMessage: string,
  identity: CollaboratorIdentity | null,
): string {
  const normalized = commitMessage.trimEnd();
  if (!identity) return normalized;

  const trailer = `Co-authored-by: ${identity.commitName} <${identity.commitEmail}>`;
  if (normalized.includes(trailer)) return normalized;
  return `${normalized}\n\n${trailer}`;
}

/**
 * Append a best-effort PR attribution note.
 */
export function addPrCollaborationNote(
  prBody: string,
  identity: CollaboratorIdentity | null,
): string {
  const normalized = prBody.trimEnd();
  if (!identity) return normalized;

  const note = `_Opened collaboratively by ${identity.displayName} and open-swe._`;
  if (normalized.includes(note)) return normalized;
  if (!normalized) return note;
  return `${normalized}\n\n${note}`;
}
