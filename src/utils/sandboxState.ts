/**
 * In-memory thread → sandbox backend cache.
 * Mirrors agent/utils/sandbox_state.py
 *
 * Also manages LangGraph thread metadata for sandbox ID persistence
 * (allows reconnection across process restarts via the LangGraph API).
 */

import { Client } from "@langchain/langgraph-sdk";
import type { SandboxBackendProtocol } from "deepagents";

// ─── In-process cache ─────────────────────────────────────────────────────────

const SANDBOX_BACKENDS = new Map<string, SandboxBackendProtocol>();

/** Sentinel stored in thread metadata while sandbox creation is in progress. */
export const SANDBOX_CREATING = "__creating__";

export function getSandboxBackend(threadId: string): SandboxBackendProtocol | undefined {
  return SANDBOX_BACKENDS.get(threadId);
}

export function setSandboxBackend(threadId: string, backend: SandboxBackendProtocol): void {
  SANDBOX_BACKENDS.set(threadId, backend);
}

export function deleteSandboxBackend(threadId: string): void {
  SANDBOX_BACKENDS.delete(threadId);
}

// ─── LangGraph thread metadata ────────────────────────────────────────────────

function getLangGraphClient(): Client {
  return new Client({
    apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024",
  });
}

const METADATA_KEY_SANDBOX_ID = "sandbox_id";
const METADATA_KEY_REPO_DIR = "repo_dir";
const METADATA_KEY_BRANCH = "branch_name";
const METADATA_KEY_BASE_BRANCH = "base_branch";

export interface SandboxMetadata {
  sandboxId: string | null;
  repoDir: string | null;
  branchName: string | null;
  baseBranch: string | null;
}

export async function getSandboxMetadata(threadId: string): Promise<SandboxMetadata> {
  try {
    const client = getLangGraphClient();
    const thread = await client.threads.get(threadId);
    const meta = (thread?.metadata ?? {}) as Record<string, unknown>;
    return {
      sandboxId: (meta[METADATA_KEY_SANDBOX_ID] as string) ?? null,
      repoDir: (meta[METADATA_KEY_REPO_DIR] as string) ?? null,
      branchName: (meta[METADATA_KEY_BRANCH] as string) ?? null,
      baseBranch: (meta[METADATA_KEY_BASE_BRANCH] as string) ?? null,
    };
  } catch {
    return {
      sandboxId: null,
      repoDir: null,
      branchName: null,
      baseBranch: null,
    };
  }
}

export async function setSandboxMetadata(
  threadId: string,
  metadata: Partial<{
    sandboxId: string;
    repoDir: string;
    branchName: string;
    baseBranch: string;
  }>,
): Promise<void> {
  const client = getLangGraphClient();
  const patch: Record<string, string> = {};
  if (metadata.sandboxId !== undefined) patch[METADATA_KEY_SANDBOX_ID] = metadata.sandboxId;
  if (metadata.repoDir !== undefined) patch[METADATA_KEY_REPO_DIR] = metadata.repoDir;
  if (metadata.branchName !== undefined) patch[METADATA_KEY_BRANCH] = metadata.branchName;
  if (metadata.baseBranch !== undefined) patch[METADATA_KEY_BASE_BRANCH] = metadata.baseBranch;

  await client.threads.update(threadId, { metadata: patch });
}

/**
 * Poll thread metadata until sandbox_id is populated (i.e., another invocation
 * finished creating it). Returns null on timeout.
 */
export async function waitForSandboxId(
  threadId: string,
  timeoutMs = 180_000,
  intervalMs = 2_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { sandboxId } = await getSandboxMetadata(threadId);
    if (sandboxId && sandboxId !== SANDBOX_CREATING) return sandboxId;
    await sleep(intervalMs);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
