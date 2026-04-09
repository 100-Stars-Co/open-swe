/**
 * Git CLI wrappers and GitHub REST API utilities.
 * Mirrors agent/utils/github.py
 *
 * All git operations run inside the sandbox via execute().
 */

import type { SandboxBackendProtocol } from "deepagents";

const GITHUB_API_BASE = "https://api.github.com";
const HTTP_CREATED = 201;
const HTTP_UNPROCESSABLE = 422;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecuteResult {
  output: string;
  exitCode: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function runGit(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
  command: string,
): Promise<ExecuteResult> {
  return Promise.resolve(sandbox.execute(`cd ${shellQuote(repoDir)} && ${command}`)).then((r) => ({
    output: r.output,
    exitCode: r.exitCode ?? 0,
  }));
}

/** Simple POSIX shell quoting — wraps in single quotes and escapes embedded single quotes. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ─── Git repo checks ──────────────────────────────────────────────────────────

export async function isValidGitRepo(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
): Promise<boolean> {
  const result = await sandbox.execute(`test -d ${shellQuote(`${repoDir}/.git`)} && echo exists`);
  return result.exitCode === 0 && result.output.includes("exists");
}

export async function removeDirectory(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
): Promise<boolean> {
  const result = await sandbox.execute(`rm -rf ${shellQuote(repoDir)}`);
  return result.exitCode === 0;
}

export async function gitHasUncommittedChanges(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
): Promise<boolean> {
  const result = await runGit(sandbox, repoDir, "git status --porcelain");
  return result.exitCode === 0 && result.output.trim().length > 0;
}

export async function gitHasUnpushedCommits(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
): Promise<boolean> {
  const cmd =
    "git log --oneline @{upstream}..HEAD 2>/dev/null " +
    "|| git log --oneline origin/HEAD..HEAD 2>/dev/null || echo ''";
  const result = await runGit(sandbox, repoDir, cmd);
  return result.exitCode === 0 && result.output.trim().length > 0;
}

export async function gitCurrentBranch(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
): Promise<string> {
  const result = await runGit(sandbox, repoDir, "git rev-parse --abbrev-ref HEAD");
  return result.output.trim();
}

// ─── Git operations ───────────────────────────────────────────────────────────

export async function gitFetchOrigin(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
): Promise<ExecuteResult> {
  return runGit(sandbox, repoDir, "git fetch origin 2>/dev/null || true");
}

export async function gitPullBranch(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
  branch: string,
  token: string,
): Promise<ExecuteResult> {
  const remote = `https://x-access-token:${token}@github.com`;
  const cmd = `git pull ${shellQuote(remote)} ${shellQuote(branch)} 2>&1`;
  return runGit(sandbox, repoDir, cmd);
}

export async function gitCheckoutBranch(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
  branch: string,
): Promise<boolean> {
  // Try switching to existing branch first, then create it
  const existing = await runGit(sandbox, repoDir, `git checkout ${shellQuote(branch)} 2>&1`);
  if (existing.exitCode === 0) return true;

  const create = await runGit(sandbox, repoDir, `git checkout -b ${shellQuote(branch)} 2>&1`);
  return create.exitCode === 0;
}

export async function gitCheckoutExistingBranch(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
  branch: string,
): Promise<ExecuteResult> {
  return runGit(sandbox, repoDir, `git checkout ${shellQuote(branch)} 2>&1`);
}

export async function gitConfigUser(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
  name: string,
  email: string,
): Promise<void> {
  await runGit(sandbox, repoDir, `git config user.name ${shellQuote(name)}`);
  await runGit(sandbox, repoDir, `git config user.email ${shellQuote(email)}`);
}

export async function gitAddAll(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
): Promise<ExecuteResult> {
  return runGit(sandbox, repoDir, "git add -A");
}

export async function gitCommit(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
  message: string,
): Promise<ExecuteResult> {
  return runGit(sandbox, repoDir, `git commit -m ${shellQuote(message)}`);
}

export async function gitPush(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
  branch: string,
  token: string,
  owner: string,
  repo: string,
): Promise<ExecuteResult> {
  const remote = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  return runGit(sandbox, repoDir, `git push ${shellQuote(remote)} HEAD:${shellQuote(branch)} 2>&1`);
}

export async function setupGitCredentials(
  sandbox: SandboxBackendProtocol,
  token: string,
): Promise<void> {
  const helper = `!f() { echo "password=${token}"; echo "username=x-access-token"; }; f`;
  await sandbox.execute(`git config --global credential.helper ${shellQuote(helper)}`);
}

export async function cleanupGitCredentials(sandbox: SandboxBackendProtocol): Promise<void> {
  await sandbox.execute("git config --global --unset credential.helper || true");
}

// ─── GitHub REST API ──────────────────────────────────────────────────────────

export async function getGithubDefaultBranch(
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const resp = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
    headers: githubHeaders(token),
  });
  if (!resp.ok) throw new Error(`Failed to get repo info: ${resp.status}`);
  const data = (await resp.json()) as { default_branch: string };
  return data.default_branch;
}

export interface PullRequest {
  url: string;
  number: number;
  html_url: string;
}

export async function createGithubPr(
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
  token: string,
  draft = true,
): Promise<PullRequest> {
  const resp = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, head, base, draft }),
  });

  if (resp.status === HTTP_UNPROCESSABLE) {
    // PR may already exist — search for it
    const existing = await findOpenPr(owner, repo, head, token);
    if (existing) return existing;
  }

  if (resp.status !== HTTP_CREATED) {
    const text = await resp.text();
    throw new Error(`Failed to create PR (${resp.status}): ${text}`);
  }

  return resp.json() as Promise<PullRequest>;
}

async function findOpenPr(
  owner: string,
  repo: string,
  head: string,
  token: string,
): Promise<PullRequest | null> {
  const resp = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${head}`,
    { headers: githubHeaders(token) },
  );
  if (!resp.ok) return null;
  const prs = (await resp.json()) as PullRequest[];
  return prs[0] ?? null;
}

export async function postGithubComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  token: string,
): Promise<void> {
  const resp = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to post GitHub comment (${resp.status}): ${text}`);
  }
}

export async function addReactionToComment(
  owner: string,
  repo: string,
  commentId: number,
  reaction: string,
  token: string,
): Promise<void> {
  await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ content: reaction }),
  });
}
