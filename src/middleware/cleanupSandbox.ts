/**
 * Cleanup sandbox middleware — fires after agent loop finishes.
 * Mirrors agent/middleware/cleanup_sandbox.py
 *
 * Only deletes Daytona sandboxes (they cost money). Other providers
 * (local, etc.) are left intact.
 */

import { createMiddleware } from "langchain";
import { deleteSandboxBackend } from "../utils/sandboxState.js";
import { setSandboxMetadata } from "../utils/sandboxState.js";

export const cleanupSandboxMiddleware = createMiddleware({
  name: "CleanupSandbox",
  afterAgent: async (state) => {
    const configurable = (state as Record<string, unknown>).configurable as
      | Record<string, unknown>
      | undefined;
    const threadId = configurable?.thread_id as string | undefined;
    const sandboxId = configurable?.sandbox_id as string | undefined;

    if (!threadId) return {};

    const sandboxType = process.env.SANDBOX_TYPE ?? "local";
    if (sandboxType !== "daytona") return {};

    // Remove from in-process cache
    deleteSandboxBackend(threadId);

    // Clear persisted sandbox ID from thread metadata
    if (sandboxId) {
      try {
        await setSandboxMetadata(threadId, { sandboxId: "" });
        const { deleteDaytonaSandbox } = await import("../integrations/daytona.js");
        await deleteDaytonaSandbox(sandboxId);
      } catch (err) {
        console.error(`[cleanupSandbox] Failed to delete Daytona sandbox ${sandboxId}:`, err);
      }
    }

    return {};
  },
});
