import { randomUUID } from "node:crypto";
import { runAgent } from "../runtime/agentRuntime.js";
import { getAgentStateStore } from "../state/index.js";

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function processThreadJob(threadId: string): Promise<void> {
  const store = getAgentStateStore();

  for (;;) {
    const thread = await store.getThread(threadId);
    if (!thread) return;

    if (thread.interruptionRequested && thread.status !== "busy") {
      await store.updateThread(threadId, {
        status: "interrupted",
        currentRunId: null,
      });
      return;
    }

    const pending = await store.claimNextPendingMessage(threadId);
    if (!pending) {
      await store.updateThread(threadId, {
        status: thread.interruptionRequested ? "interrupted" : "idle",
        currentRunId: null,
        interruptionRequested: false,
      });
      return;
    }

    const runId = randomUUID();
    await store.createRun({
      runId,
      threadId,
      status: "running",
      triggerMessage: pending.message,
    });
    await store.updateThread(threadId, {
      status: "busy",
      currentRunId: runId,
      lastError: null,
    });

    try {
      await runAgent(
        {
          ...(thread.configurable as Record<string, unknown>),
          thread_id: thread.threadId,
        },
        pending.message,
      );

      const finishedAt = new Date().toISOString();
      await store.updateRun(runId, {
        status: "success",
        finishedAt,
      });
      await store.markPendingMessageProcessed(pending.id);
    } catch (err) {
      const message = getErrorMessage(err);
      const finishedAt = new Date().toISOString();

      await store.updateRun(runId, {
        status: "error",
        error: message,
        finishedAt,
      });
      await store.updateThread(threadId, {
        status: "error",
        lastError: message,
        currentRunId: null,
      });
      await store.releasePendingMessageClaim(pending.id);
      throw err;
    }

    const refreshed = await store.getThread(threadId);
    if (refreshed?.interruptionRequested) {
      await store.updateThread(threadId, {
        status: "interrupted",
        currentRunId: null,
        interruptionRequested: false,
      });
      return;
    }
  }
}
