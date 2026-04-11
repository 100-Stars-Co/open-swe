import { InMemoryAgentStateStore } from "./inMemoryState.js";
import { PostgresAgentStateStore } from "./postgresState.js";
import type { AgentStateStore } from "./types.js";

let store: AgentStateStore | null = null;

export function getAgentStateStore(): AgentStateStore {
  if (!store) {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    store = databaseUrl
      ? new PostgresAgentStateStore(databaseUrl)
      : new InMemoryAgentStateStore();
  }
  return store;
}

export async function ensureAgentStateStoreReady(): Promise<void> {
  await getAgentStateStore().ensureReady();
}

export function resetAgentStateStoreForTests(nextStore?: AgentStateStore): void {
  store = nextStore ?? null;
}

export type {
  AgentRunRecord,
  AgentRunStatus,
  AgentStateStore,
  AgentThreadRecord,
  AgentThreadStatus,
  PendingMessageRecord,
  ThreadMetadata,
  UpdateThreadInput,
  UpsertThreadInput,
} from "./types.js";
