/**
 * Cleanup sandbox middleware — fires after agent loop finishes.
 * Mirrors agent/middleware/cleanup_sandbox.py
 *
 * Uses provider-aware cleanup, but keeps best-effort semantics so agent
 * completion is not blocked on sandbox teardown failures.
 */

import { createMiddleware } from "langchain";
import { cleanupSandboxForThread } from "../utils/sandboxLifecycle.js";

export const cleanupSandboxMiddleware = createMiddleware({
  name: "CleanupSandbox",
  afterAgent: async (state) => {
    const configurable = (state as Record<string, unknown>).configurable as
      | Record<string, unknown>
      | undefined;
    const threadId = configurable?.thread_id as string | undefined;
    const sandboxId = configurable?.sandbox_id as string | undefined;

    if (!threadId) return {};
    try {
      await cleanupSandboxForThread(threadId, sandboxId);
    } catch (err) {
      console.error(
        `[cleanupSandbox] Failed to clean up sandbox for thread ${threadId}:`,
        err,
      );
    }

    return {};
  },
});
