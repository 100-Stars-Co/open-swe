export type AgentThreadStatus = "idle" | "busy" | "interrupted" | "error";

export type AgentRunStatus = "queued" | "running" | "success" | "error" | "cancelled";

export interface ThreadMetadata {
  sandboxId?: string | null;
  repoDir?: string | null;
  branchName?: string | null;
  baseBranch?: string | null;
  githubTokenEncrypted?: string | null;
  source?: string | null;
}

export interface AgentThreadRecord {
  threadId: string;
  status: AgentThreadStatus;
  source: string | null;
  repoOwner: string | null;
  repoName: string | null;
  issueNumber: number | null;
  configurable: Record<string, unknown>;
  metadata: ThreadMetadata;
  interruptionRequested: boolean;
  currentRunId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunRecord {
  runId: string;
  threadId: string;
  status: AgentRunStatus;
  triggerMessage: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PendingMessageRecord {
  id: string;
  threadId: string;
  message: string;
  createdAt: string;
  claimedAt: string | null;
  processedAt: string | null;
}

export interface UpsertThreadInput {
  threadId: string;
  status?: AgentThreadStatus;
  source?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  issueNumber?: number | null;
  configurable?: Record<string, unknown>;
  metadata?: Partial<ThreadMetadata>;
  interruptionRequested?: boolean;
  currentRunId?: string | null;
  lastError?: string | null;
}

export interface UpdateThreadInput {
  status?: AgentThreadStatus;
  source?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  issueNumber?: number | null;
  configurable?: Record<string, unknown>;
  metadata?: Partial<ThreadMetadata>;
  interruptionRequested?: boolean;
  currentRunId?: string | null;
  lastError?: string | null;
}

export interface CreateRunInput {
  runId: string;
  threadId: string;
  status: AgentRunStatus;
  triggerMessage: string;
  error?: string | null;
}

export interface UpdateRunInput {
  status?: AgentRunStatus;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface AgentStateStore {
  ensureReady(): Promise<void>;
  listThreads(limit?: number): Promise<AgentThreadRecord[]>;
  getThread(threadId: string): Promise<AgentThreadRecord | null>;
  upsertThread(input: UpsertThreadInput): Promise<AgentThreadRecord>;
  updateThread(threadId: string, input: UpdateThreadInput): Promise<AgentThreadRecord | null>;
  deleteThread(threadId: string): Promise<void>;
  createRun(input: CreateRunInput): Promise<AgentRunRecord>;
  updateRun(runId: string, input: UpdateRunInput): Promise<AgentRunRecord | null>;
  listRuns(threadId: string): Promise<AgentRunRecord[]>;
  enqueueMessage(threadId: string, message: string): Promise<PendingMessageRecord>;
  claimNextPendingMessage(threadId: string): Promise<PendingMessageRecord | null>;
  markPendingMessageProcessed(id: string): Promise<void>;
  releasePendingMessageClaim(id: string): Promise<void>;
  listPendingMessages(threadId: string): Promise<PendingMessageRecord[]>;
}
