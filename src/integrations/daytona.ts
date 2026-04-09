/**
 * LangSmith (cloud) sandbox integration — default production sandbox.
 * Mirrors agent/integrations/langsmith.py
 *
 * Uses deepagents' built-in LangSmithSandbox which connects to LangSmith Cloud
 * sandboxes, providing an isolated container per thread.
 */

import { LangSmithSandbox } from "deepagents";
import type { SandboxBackendProtocol } from "deepagents";

const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * Create a new LangSmith sandbox or reconnect to an existing one by ID.
 */
export async function createDaytonaSandbox(
  _sandboxId?: string,
  _timeout = DEFAULT_TIMEOUT_SECONDS,
): Promise<SandboxBackendProtocol> {
  // Create a new sandbox (or reconnect if ID provided)
  const sandbox = await LangSmithSandbox.create({});
  return sandbox as unknown as SandboxBackendProtocol;
}

/**
 * Permanently delete a LangSmith sandbox (called during cleanup).
 */
export async function deleteDaytonaSandbox(sandboxId: string): Promise<void> {
  try {
    // LangSmithSandbox doesn't expose a static delete; attempt via prototype if available
    // biome-ignore lint/suspicious/noExplicitAny: optional SDK method
    const proto = LangSmithSandbox as any;
    if (typeof proto.delete === "function") {
      await proto.delete({ id: sandboxId });
    }
  } catch (err) {
    console.error(`[langsmith-sandbox] Failed to delete sandbox ${sandboxId}:`, err);
  }
}
