import { randomUUID } from "node:crypto";
import type {
  AgentRunRecord,
  AgentStateStore,
  AgentThreadRecord,
  CreateRunInput,
  PendingMessageRecord,
  ThreadMetadata,
  UpdateRunInput,
  UpdateThreadInput,
  UpsertThreadInput,
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function mergeMetadata(
  current: ThreadMetadata,
  incoming?: Partial<ThreadMetadata>,
): ThreadMetadata {
  return {
    ...current,
    ...(incoming ?? {}),
  };
}

export class InMemoryAgentStateStore implements AgentStateStore {
  private readonly threads = new Map<string, AgentThreadRecord>();
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly pendingMessages = new Map<string, PendingMessageRecord[]>();

  async ensureReady(): Promise<void> {}

  async listThreads(limit = 100): Promise<AgentThreadRecord[]> {
    return Array.from(this.threads.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async getThread(threadId: string): Promise<AgentThreadRecord | null> {
    return this.threads.get(threadId) ?? null;
  }

  async upsertThread(input: UpsertThreadInput): Promise<AgentThreadRecord> {
    const existing = this.threads.get(input.threadId);
    const record: AgentThreadRecord = existing
      ? {
          ...existing,
          status: input.status ?? existing.status,
          source: input.source ?? existing.source,
          repoOwner: input.repoOwner ?? existing.repoOwner,
          repoName: input.repoName ?? existing.repoName,
          issueNumber: input.issueNumber ?? existing.issueNumber,
          configurable: input.configurable ?? existing.configurable,
          metadata: mergeMetadata(existing.metadata, input.metadata),
          interruptionRequested:
            input.interruptionRequested ?? existing.interruptionRequested,
          currentRunId:
            input.currentRunId === undefined ? existing.currentRunId : input.currentRunId,
          lastError: input.lastError === undefined ? existing.lastError : input.lastError,
          updatedAt: now(),
        }
      : {
          threadId: input.threadId,
          status: input.status ?? "idle",
          source: input.source ?? null,
          repoOwner: input.repoOwner ?? null,
          repoName: input.repoName ?? null,
          issueNumber: input.issueNumber ?? null,
          configurable: input.configurable ?? {},
          metadata: mergeMetadata({}, input.metadata),
          interruptionRequested: input.interruptionRequested ?? false,
          currentRunId: input.currentRunId ?? null,
          lastError: input.lastError ?? null,
          createdAt: now(),
          updatedAt: now(),
        };

    this.threads.set(input.threadId, record);
    return record;
  }

  async updateThread(threadId: string, input: UpdateThreadInput): Promise<AgentThreadRecord | null> {
    const existing = this.threads.get(threadId);
    if (!existing) return null;

    const updated: AgentThreadRecord = {
      ...existing,
      status: input.status ?? existing.status,
      source: input.source ?? existing.source,
      repoOwner: input.repoOwner ?? existing.repoOwner,
      repoName: input.repoName ?? existing.repoName,
      issueNumber: input.issueNumber ?? existing.issueNumber,
      configurable: input.configurable ?? existing.configurable,
      metadata: mergeMetadata(existing.metadata, input.metadata),
      interruptionRequested: input.interruptionRequested ?? existing.interruptionRequested,
      currentRunId: input.currentRunId === undefined ? existing.currentRunId : input.currentRunId,
      lastError: input.lastError === undefined ? existing.lastError : input.lastError,
      updatedAt: now(),
    };

    this.threads.set(threadId, updated);
    return updated;
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
    this.pendingMessages.delete(threadId);
    for (const [runId, run] of this.runs.entries()) {
      if (run.threadId === threadId) {
        this.runs.delete(runId);
      }
    }
  }

  async createRun(input: CreateRunInput): Promise<AgentRunRecord> {
    const ts = now();
    const record: AgentRunRecord = {
      runId: input.runId,
      threadId: input.threadId,
      status: input.status,
      triggerMessage: input.triggerMessage,
      error: input.error ?? null,
      createdAt: ts,
      updatedAt: ts,
      startedAt: input.status === "running" ? ts : null,
      finishedAt: ["success", "error", "cancelled"].includes(input.status) ? ts : null,
    };
    this.runs.set(record.runId, record);
    return record;
  }

  async updateRun(runId: string, input: UpdateRunInput): Promise<AgentRunRecord | null> {
    const existing = this.runs.get(runId);
    if (!existing) return null;

    const updated: AgentRunRecord = {
      ...existing,
      status: input.status ?? existing.status,
      error: input.error === undefined ? existing.error : input.error,
      startedAt: input.startedAt === undefined ? existing.startedAt : input.startedAt,
      finishedAt: input.finishedAt === undefined ? existing.finishedAt : input.finishedAt,
      updatedAt: now(),
    };

    this.runs.set(runId, updated);
    return updated;
  }

  async listRuns(threadId: string): Promise<AgentRunRecord[]> {
    return Array.from(this.runs.values())
      .filter((run) => run.threadId === threadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async enqueueMessage(threadId: string, message: string): Promise<PendingMessageRecord> {
    const queue = this.pendingMessages.get(threadId) ?? [];
    const record: PendingMessageRecord = {
      id: randomUUID(),
      threadId,
      message,
      createdAt: now(),
      claimedAt: null,
      processedAt: null,
    };
    queue.push(record);
    this.pendingMessages.set(threadId, queue);
    return record;
  }

  async claimNextPendingMessage(threadId: string): Promise<PendingMessageRecord | null> {
    const queue = this.pendingMessages.get(threadId) ?? [];
    const next = queue.find((item) => item.claimedAt === null && item.processedAt === null);
    if (!next) return null;
    next.claimedAt = now();
    return { ...next };
  }

  async markPendingMessageProcessed(id: string): Promise<void> {
    for (const queue of this.pendingMessages.values()) {
      const record = queue.find((item) => item.id === id);
      if (record) {
        record.processedAt = now();
        return;
      }
    }
  }

  async releasePendingMessageClaim(id: string): Promise<void> {
    for (const queue of this.pendingMessages.values()) {
      const record = queue.find((item) => item.id === id);
      if (record) {
        record.claimedAt = null;
        return;
      }
    }
  }

  async listPendingMessages(threadId: string): Promise<PendingMessageRecord[]> {
    return (this.pendingMessages.get(threadId) ?? [])
      .filter((item) => item.processedAt === null)
      .map((item) => ({ ...item }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
