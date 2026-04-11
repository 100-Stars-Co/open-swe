import { getAgentStateStore, type AgentThreadStatus } from "../state/index.js";

const KNOWN_THREAD_STATUSES = new Set<AgentThreadStatus>(["idle", "busy", "interrupted", "error"]);

interface ThreadLookupResult {
  threadId: string;
  status: AgentThreadStatus | "missing";
}

interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

async function fetchThreadStatus(threadId: string): Promise<ThreadLookupResult> {
  const thread = await getAgentStateStore().getThread(threadId);
  if (!thread) {
    return { threadId, status: "missing" };
  }

  if (!KNOWN_THREAD_STATUSES.has(thread.status)) {
    throw new Error(`Unexpected thread status for ${threadId}`);
  }

  return { threadId, status: thread.status };
}

export function formatThreadState(result: ThreadLookupResult): string {
  if (result.status === "missing") {
    return `Thread ${result.threadId}: missing`;
  }

  if (result.status === "busy") {
    return `Thread ${result.threadId}: busy`;
  }

  return `Thread ${result.threadId}: not busy (${result.status})`;
}

export async function runThreadStateCli(
  args: string[] = process.argv.slice(2),
  io: CliIO = {
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  },
): Promise<number> {
  const [threadId] = args;

  if (!threadId) {
    io.stderr("Usage: bun run thread:state <thread-id>");
    return 1;
  }

  try {
    const result = await fetchThreadStatus(threadId);
    io.stdout(formatThreadState(result));
    return result.status === "missing" ? 2 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Failed to check thread state for ${threadId}: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runThreadStateCli();
  process.exit(exitCode);
}
