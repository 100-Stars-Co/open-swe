/**
 * GitHub App authentication utilities.
 * Mirrors agent/utils/github_app.py
 *
 * Generates a signed JWT for the GitHub App and exchanges it
 * for a short-lived installation token.
 */

import { createPrivateKey } from "crypto";
import { SignJWT, importPKCS8 } from "jose";

const GITHUB_API_BASE = "https://api.github.com";
const JWT_EXPIRY_SECONDS = 600; // 10 minutes (GitHub App maximum)

function getAppCredentials(): {
  appId: string;
  privateKey: string;
  installationId: string;
} {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  if (!appId || !privateKey || !installationId) {
    throw new Error(
      "Missing GitHub App credentials. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, " +
        "and GITHUB_APP_INSTALLATION_ID environment variables.",
    );
  }

  // Allow \n literal in env var (common in .env files) to be treated as real newlines
  return {
    appId,
    privateKey: privateKey.replace(/\\n/g, "\n"),
    installationId,
  };
}

/**
 * Generate a signed RS256 JWT for GitHub App authentication.
 */
export async function generateAppJwt(): Promise<string> {
  const { appId, privateKey } = getAppCredentials();
  const now = Math.floor(Date.now() / 1000);

  // Convert PKCS#1 ("BEGIN RSA PRIVATE KEY") to PKCS#8 ("BEGIN PRIVATE KEY") if needed,
  // since jose's importPKCS8 only accepts PKCS#8 format.
  const normalizedKey = privateKey.includes("BEGIN RSA PRIVATE KEY")
    ? createPrivateKey(privateKey)
        .export({ type: "pkcs8", format: "pem" })
        .toString()
    : privateKey;

  const key = await importPKCS8(normalizedKey, "RS256");

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60) // 60s clock skew tolerance
    .setExpirationTime(now + JWT_EXPIRY_SECONDS)
    .setIssuer(appId)
    .sign(key);
}

/**
 * Exchange the App JWT for a short-lived installation token.
 * Returns null when credentials are not configured (graceful degradation).
 */
export async function getInstallationToken(): Promise<string | null> {
  try {
    const { installationId } = getAppCredentials();
    const jwt = await generateAppJwt();

    const response = await fetch(
      `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitHub App token exchange failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as { token: string };
    return data.token;
  } catch (err) {
    console.error("[githubApp] Failed to get installation token:", err);
    return null;
  }
}
