/**
 * Helpers for resolving portable writable paths inside sandboxes.
 * Mirrors agent/utils/sandbox_paths.py
 */

import * as posixpath from "node:path/posix";
import type { SandboxBackendProtocol } from "deepagents";

type SyncExecuteResult = { exitCode: number; output: string };

function executeSync(sandbox: SandboxBackendProtocol, command: string): SyncExecuteResult {
  return sandbox.execute(command) as unknown as SyncExecuteResult;
}

const WORK_DIR_CACHE = new WeakMap<object, string>();

/**
 * Resolve the repository directory for a sandbox backend.
 */
export function resolveRepoDir(sandbox: SandboxBackendProtocol, repoName: string): string {
  if (!repoName) throw new Error("repoName must be a non-empty string");
  const workDir = resolveSandboxWorkDir(sandbox);
  return posixpath.join(workDir, repoName);
}

/**
 * Resolve a writable base directory for repository operations.
 */
export function resolveSandboxWorkDir(sandbox: SandboxBackendProtocol): string {
  const cached = WORK_DIR_CACHE.get(sandbox as object);
  if (cached) return cached;

  const candidates = iterWorkDirCandidates(sandbox);
  const checkedCandidates: string[] = [];

  for (const candidate of candidates) {
    checkedCandidates.push(candidate);
    if (isWritableDirectory(sandbox, candidate)) {
      WORK_DIR_CACHE.set(sandbox as object, candidate);
      return candidate;
    }
  }

  const msg = checkedCandidates.length
    ? `Failed to resolve a writable sandbox work directory. Candidates checked: ${checkedCandidates.join(", ")}`
    : "Failed to resolve a writable sandbox work directory";
  throw new Error(msg);
}

function* iterWorkDirCandidates(sandbox: SandboxBackendProtocol): Generator<string> {
  const seen = new Set<string>();

  // Try pwd first
  const shellWorkDir = resolveShellPath(sandbox, "pwd");
  if (shellWorkDir && !seen.has(shellWorkDir)) {
    seen.add(shellWorkDir);
    yield shellWorkDir;
  }

  // Try $HOME
  const shellHomeDir = resolveShellPath(sandbox, 'printf "%s" "$HOME"');
  if (shellHomeDir && !seen.has(shellHomeDir)) {
    seen.add(shellHomeDir);
    yield shellHomeDir;
  }
}

function resolveShellPath(sandbox: SandboxBackendProtocol, command: string): string | null {
  const result = executeSync(sandbox, command);
  if (result.exitCode !== 0) return null;
  return normalizePath(result.output);
}

function normalizePath(rawPath: string | null): string | null {
  if (rawPath === null) return null;
  const path = rawPath.trim();
  if (!path || !path.startsWith("/")) return null;
  return posixpath.normalize(path);
}

function isWritableDirectory(sandbox: SandboxBackendProtocol, directory: string): boolean {
  const safeDir = shellQuote(directory);
  const result = executeSync(sandbox, `test -d ${safeDir} && test -w ${safeDir}`);
  return result.exitCode === 0;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
