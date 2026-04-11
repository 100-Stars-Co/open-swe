import postgres from "postgres";
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

interface ThreadRow {
  thread_id: string;
  status: AgentThreadRecord["status"];
  source: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  issue_number: number | null;
  configurable_json: Record<string, unknown> | null;
  metadata_json: ThreadMetadata | null;
  interruption_requested: boolean;
  current_run_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  run_id: string;
  thread_id: string;
  status: AgentRunRecord["status"];
  trigger_message: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface PendingMessageRow {
  id: bigint;
  thread_id: string;
  message: string;
  created_at: Date;
  claimed_at: Date | null;
  processed_at: Date | null;
}

function toThreadRecord(row: ThreadRow): AgentThreadRecord {
  return {
    threadId: row.thread_id,
    status: row.status,
    source: row.source,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    issueNumber: row.issue_number,
    configurable: row.configurable_json ?? {},
    metadata: row.metadata_json ?? {},
    interruptionRequested: row.interruption_requested,
    currentRunId: row.current_run_id,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toRunRecord(row: RunRow): AgentRunRecord {
  return {
    runId: row.run_id,
    threadId: row.thread_id,
    status: row.status,
    triggerMessage: row.trigger_message,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function toPendingRecord(row: PendingMessageRow): PendingMessageRecord {
  return {
    id: row.id.toString(),
    threadId: row.thread_id,
    message: row.message,
    createdAt: row.created_at.toISOString(),
    claimedAt: row.claimed_at?.toISOString() ?? null,
    processedAt: row.processed_at?.toISOString() ?? null,
  };
}

function buildThreadPatch(input: UpdateThreadInput | UpsertThreadInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.source !== undefined) patch.source = input.source;
  if (input.repoOwner !== undefined) patch.repo_owner = input.repoOwner;
  if (input.repoName !== undefined) patch.repo_name = input.repoName;
  if (input.issueNumber !== undefined) patch.issue_number = input.issueNumber;
  if (input.configurable !== undefined) patch.configurable_json = input.configurable;
  if (input.metadata !== undefined) patch.metadata_json = input.metadata;
  if (input.interruptionRequested !== undefined) {
    patch.interruption_requested = input.interruptionRequested;
  }
  if (input.currentRunId !== undefined) patch.current_run_id = input.currentRunId;
  if (input.lastError !== undefined) patch.last_error = input.lastError;
  return patch;
}

export class PostgresAgentStateStore implements AgentStateStore {
  private readonly sql: any;
  private initialized = false;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, { max: 5 });
  }

  async ensureReady(): Promise<void> {
    if (this.initialized) return;

    await this.sql`
      create table if not exists agent_threads (
        thread_id text primary key,
        status text not null,
        source text,
        repo_owner text,
        repo_name text,
        issue_number integer,
        configurable_json jsonb not null default '{}'::jsonb,
        metadata_json jsonb not null default '{}'::jsonb,
        interruption_requested boolean not null default false,
        current_run_id text,
        last_error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await this.sql`
      create table if not exists agent_runs (
        run_id text primary key,
        thread_id text not null references agent_threads(thread_id) on delete cascade,
        status text not null,
        trigger_message text not null,
        error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        started_at timestamptz,
        finished_at timestamptz
      )
    `;
    await this.sql`
      create table if not exists agent_pending_messages (
        id bigserial primary key,
        thread_id text not null references agent_threads(thread_id) on delete cascade,
        message text not null,
        created_at timestamptz not null default now(),
        claimed_at timestamptz,
        processed_at timestamptz
      )
    `;
    await this.sql`
      create index if not exists idx_agent_pending_messages_thread_created
      on agent_pending_messages(thread_id, created_at)
    `;
    this.initialized = true;
  }

  async listThreads(limit = 100): Promise<AgentThreadRecord[]> {
    await this.ensureReady();
    const rows = await this.sql<ThreadRow[]>`
      select * from agent_threads
      order by updated_at desc
      limit ${limit}
    `;
    return rows.map(toThreadRecord);
  }

  async getThread(threadId: string): Promise<AgentThreadRecord | null> {
    await this.ensureReady();
    const [row] = await this.sql<ThreadRow[]>`
      select * from agent_threads where thread_id = ${threadId}
    `;
    return row ? toThreadRecord(row) : null;
  }

  async upsertThread(input: UpsertThreadInput): Promise<AgentThreadRecord> {
    await this.ensureReady();
    const existing = await this.getThread(input.threadId);
    const metadata = {
      ...(existing?.metadata ?? {}),
      ...(input.metadata ?? {}),
    };
    const configurable = input.configurable ?? existing?.configurable ?? {};

    const [row] = await this.sql<ThreadRow[]>`
      insert into agent_threads (
        thread_id,
        status,
        source,
        repo_owner,
        repo_name,
        issue_number,
        configurable_json,
        metadata_json,
        interruption_requested,
        current_run_id,
        last_error
      ) values (
        ${input.threadId},
        ${input.status ?? existing?.status ?? "idle"},
        ${input.source ?? existing?.source ?? null},
        ${input.repoOwner ?? existing?.repoOwner ?? null},
        ${input.repoName ?? existing?.repoName ?? null},
        ${input.issueNumber ?? existing?.issueNumber ?? null},
        ${this.sql.json(configurable)},
        ${this.sql.json(metadata)},
        ${input.interruptionRequested ?? existing?.interruptionRequested ?? false},
        ${input.currentRunId ?? existing?.currentRunId ?? null},
        ${input.lastError ?? existing?.lastError ?? null}
      )
      on conflict (thread_id) do update set
        status = excluded.status,
        source = excluded.source,
        repo_owner = excluded.repo_owner,
        repo_name = excluded.repo_name,
        issue_number = excluded.issue_number,
        configurable_json = excluded.configurable_json,
        metadata_json = excluded.metadata_json,
        interruption_requested = excluded.interruption_requested,
        current_run_id = excluded.current_run_id,
        last_error = excluded.last_error,
        updated_at = now()
      returning *
    `;
    return toThreadRecord(row);
  }

  async updateThread(threadId: string, input: UpdateThreadInput): Promise<AgentThreadRecord | null> {
    await this.ensureReady();
    const existing = await this.getThread(threadId);
    if (!existing) return null;

    const patch = buildThreadPatch(input);
    const metadata = input.metadata
      ? this.sql.json({ ...existing.metadata, ...input.metadata })
      : undefined;
    const configurable = input.configurable ? this.sql.json(input.configurable) : undefined;

    const [row] = await this.sql<ThreadRow[]>`
      update agent_threads
      set
        status = ${patch.status ?? existing.status},
        source = ${patch.source ?? existing.source},
        repo_owner = ${patch.repo_owner ?? existing.repoOwner},
        repo_name = ${patch.repo_name ?? existing.repoName},
        issue_number = ${patch.issue_number ?? existing.issueNumber},
        configurable_json = ${configurable ?? this.sql.json(existing.configurable)},
        metadata_json = ${metadata ?? this.sql.json(existing.metadata)},
        interruption_requested = ${
          patch.interruption_requested ?? existing.interruptionRequested
        },
        current_run_id = ${patch.current_run_id ?? existing.currentRunId},
        last_error = ${patch.last_error ?? existing.lastError},
        updated_at = now()
      where thread_id = ${threadId}
      returning *
    `;
    return row ? toThreadRecord(row) : null;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.ensureReady();
    await this.sql`delete from agent_threads where thread_id = ${threadId}`;
  }

  async createRun(input: CreateRunInput): Promise<AgentRunRecord> {
    await this.ensureReady();
    const [row] = await this.sql<RunRow[]>`
      insert into agent_runs (
        run_id, thread_id, status, trigger_message, error, started_at, finished_at
      ) values (
        ${input.runId},
        ${input.threadId},
        ${input.status},
        ${input.triggerMessage},
        ${input.error ?? null},
        ${input.status === "running" ? this.sql`now()` : null},
        ${["success", "error", "cancelled"].includes(input.status) ? this.sql`now()` : null}
      )
      returning *
    `;
    return toRunRecord(row);
  }

  async updateRun(runId: string, input: UpdateRunInput): Promise<AgentRunRecord | null> {
    await this.ensureReady();
    const [existing] = await this.sql<RunRow[]>`
      select * from agent_runs where run_id = ${runId}
    `;
    if (!existing) return null;

    const [row] = await this.sql<RunRow[]>`
      update agent_runs
      set
        status = ${input.status ?? existing.status},
        error = ${input.error === undefined ? existing.error : input.error},
        started_at = ${input.startedAt === undefined ? existing.started_at : input.startedAt},
        finished_at = ${input.finishedAt === undefined ? existing.finished_at : input.finishedAt},
        updated_at = now()
      where run_id = ${runId}
      returning *
    `;
    return toRunRecord(row);
  }

  async listRuns(threadId: string): Promise<AgentRunRecord[]> {
    await this.ensureReady();
    const rows = await this.sql<RunRow[]>`
      select * from agent_runs
      where thread_id = ${threadId}
      order by created_at desc
    `;
    return rows.map(toRunRecord);
  }

  async enqueueMessage(threadId: string, message: string): Promise<PendingMessageRecord> {
    await this.ensureReady();
    const [row] = await this.sql<PendingMessageRow[]>`
      insert into agent_pending_messages (thread_id, message)
      values (${threadId}, ${message})
      returning *
    `;
    return toPendingRecord(row);
  }

  async claimNextPendingMessage(threadId: string): Promise<PendingMessageRecord | null> {
    await this.ensureReady();
    const result = await this.sql.begin(async (tx: any) => {
      const [row] = await tx<PendingMessageRow[]>`
        select * from agent_pending_messages
        where thread_id = ${threadId}
          and processed_at is null
          and claimed_at is null
        order by created_at asc
        limit 1
        for update skip locked
      `;
      if (!row) return null;

      const [claimed] = await tx<PendingMessageRow[]>`
        update agent_pending_messages
        set claimed_at = now()
        where id = ${row.id}
        returning *
      `;
      return claimed;
    });

    return result ? toPendingRecord(result) : null;
  }

  async markPendingMessageProcessed(id: string): Promise<void> {
    await this.ensureReady();
    await this.sql`
      update agent_pending_messages
      set processed_at = now()
      where id = ${BigInt(id)}
    `;
  }

  async releasePendingMessageClaim(id: string): Promise<void> {
    await this.ensureReady();
    await this.sql`
      update agent_pending_messages
      set claimed_at = null
      where id = ${BigInt(id)}
    `;
  }

  async listPendingMessages(threadId: string): Promise<PendingMessageRecord[]> {
    await this.ensureReady();
    const rows = await this.sql<PendingMessageRow[]>`
      select * from agent_pending_messages
      where thread_id = ${threadId}
        and processed_at is null
      order by created_at asc
    `;
    return rows.map(toPendingRecord);
  }
}
