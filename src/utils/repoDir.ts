/**
 * Shared sandbox repository path resolution.
 */

const DEFAULT_SANDBOX_REPO_ROOT = "/tmp/repos";

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function getSandboxRepoRoot(): string {
  const configured = process.env.SANDBOX_REPO_ROOT?.trim();
  if (!configured) return DEFAULT_SANDBOX_REPO_ROOT;
  return configured.replace(/\/+$/, "") || DEFAULT_SANDBOX_REPO_ROOT;
}

export function resolveSandboxRepoDir(owner: string, repo: string): string {
  const root = getSandboxRepoRoot();
  return `${root}/${sanitizePathSegment(owner)}/${sanitizePathSegment(repo)}`;
}
