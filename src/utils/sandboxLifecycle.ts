/**
 * Sandbox lifecycle helpers.
 *
 * Resolves a thread's sandbox backend from cache or LangGraph metadata, and
 * recovers cleanly when a persisted sandbox ID points to a deleted sandbox.
 */

import type { SandboxBackendProtocol } from "deepagents";
import { createSandbox } from "./sandbox.js";
import {
  SANDBOX_CREATING,
  deleteSandboxBackend,
  getSandboxBackend,
  getSandboxMetadata,
  setSandboxBackend,
  setSandboxMetadata,
  waitForSandboxId,
} from "./sandboxState.js";

const DEFAULT_SANDBOX_CREATION_TIMEOUT_MS = 180_000;

function isMissingSandboxError(err: unknown): boolean {
  const message =
    err instanceof Error ? `${err.name}: ${err.message}` : typeof err === "string" ? err : "";
  return /SandboxApiException|not found/i.test(message);
}

async function clearSandboxState(threadId: string): Promise<void> {
  deleteSandboxBackend(threadId);
  await setSandboxMetadata(threadId, { sandboxId: "" }).catch(() => {});
}

async function createAndVerifySandbox(
  threadId: string,
  sandboxId?: string,
): Promise<SandboxBackendProtocol> {
  const sandbox = await createSandbox(sandboxId);
  setSandboxBackend(threadId, sandbox);

  const probe = await sandbox.execute("echo ok");
  if (probe.exitCode !== 0) throw new Error("Sandbox health check failed");

  return sandbox;
}

export async function getOrCreateSandbox(
  threadId: string,
  timeoutMs = DEFAULT_SANDBOX_CREATION_TIMEOUT_MS,
): Promise<SandboxBackendProtocol> {
  const cached = getSandboxBackend(threadId);
  if (cached) return cached;

  const meta = await getSandboxMetadata(threadId);
  let sandboxId: string | null | undefined = meta.sandboxId;

  if (sandboxId === SANDBOX_CREATING) {
    sandboxId = await waitForSandboxId(threadId, timeoutMs);
    if (!sandboxId) {
      throw new Error("Timed out waiting for sandbox to be created by concurrent invocation");
    }
  }

  if (sandboxId) {
    try {
      return await createAndVerifySandbox(threadId, sandboxId);
    } catch (err) {
      if (!isMissingSandboxError(err)) throw err;

      console.warn(
        `[sandbox] Persisted sandbox ${sandboxId} for thread ${threadId} was not found; recreating`,
      );
      await clearSandboxState(threadId);
      sandboxId = undefined;
    }
  }

  await setSandboxMetadata(threadId, { sandboxId: SANDBOX_CREATING });

  try {
    const sandbox = await createAndVerifySandbox(threadId, undefined);
    const newId = sandbox.id;
    if (newId) {
      await setSandboxMetadata(threadId, { sandboxId: newId });
    }
    return sandbox;
  } catch (err) {
    await clearSandboxState(threadId);
    throw err;
  }
}
