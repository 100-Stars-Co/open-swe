/**
 * GitHub App installation token generation.
 * Ports agent/utils/github_app.py to TypeScript.
 */

import { SignJWT, importPKCS8 } from "jose";
import { config } from "./config.ts";

/** Generate a short-lived JWT signed with the GitHub App private key (RS256). */
async function generateAppJwt(): Promise<string> {
  const privateKeyPem = config.githubAppPrivateKey.replace(/\\n/g, "\n");
  const privateKey = await importPKCS8(privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60) // issued 60s ago to account for clock skew
    .setExpirationTime(now + 540) // expires in 9 minutes (max is 10)
    .setIssuer(config.githubAppId)
    .sign(privateKey);
}

/**
 * Exchange the GitHub App JWT for an installation access token.
 * Returns the token string, or null if unavailable.
 */
export async function getGithubAppInstallationToken(): Promise<string | null> {
  if (!config.githubAppId || !config.githubAppPrivateKey || !config.githubAppInstallationId) {
    return null;
  }

  try {
    const appJwt = await generateAppJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${config.githubAppInstallationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      console.error("Failed to get GitHub App installation token:", response.status);
      return null;
    }
    const data = (await response.json()) as { token?: string };
    return data.token ?? null;
  } catch (err) {
    console.error("Failed to get GitHub App installation token:", err);
    return null;
  }
}
