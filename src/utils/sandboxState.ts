import type { SandboxBackendProtocol } from "deepagents";
import { getAgentStateStore } from "../state/index.js";

const SANDBOX_BACKENDS = new Map<string, SandboxBackendProtocol>();

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

export interface SandboxMetadata {
  sandboxId: string | null;
  repoDir: string | null;
  branchName: string | null;
  baseBranch: string | null;
}

export async function getSandboxMetadata(threadId: string): Promise<SandboxMetadata> {
  const thread = await getAgentStateStore().getThread(threadId);
  const metadata = thread?.metadata ?? {};

  return {
    sandboxId: metadata.sandboxId ?? null,
    repoDir: metadata.repoDir ?? null,
    branchName: metadata.branchName ?? null,
    baseBranch: metadata.baseBranch ?? null,
  };
}

export async function setSandboxMetadata(
  threadId: string,
  metadata: Partial<{
    sandboxId: string | null;
    repoDir: string | null;
    branchName: string | null;
    baseBranch: string | null;
  }>,
): Promise<void> {
  await getAgentStateStore().updateThread(threadId, {
    metadata,
  });
}

export async function waitForSandboxId(
  threadId: string,
  timeoutMs = 180_000,
  intervalMs = 2_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { sandboxId } = await getSandboxMetadata(threadId);
    if (sandboxId && sandboxId !== SANDBOX_CREATING) return sandboxId;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}
