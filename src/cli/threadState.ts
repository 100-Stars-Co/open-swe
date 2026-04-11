import { Client, type ThreadStatus } from "@langchain/langgraph-sdk";

const KNOWN_THREAD_STATUSES = new Set<ThreadStatus>(["idle", "busy", "interrupted", "error"]);

interface ThreadLookupResult {
  threadId: string;
  status: ThreadStatus | "missing";
}

interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function getLangGraphClient(): Client {
  return new Client({
    apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024",
  });
}

function isThreadNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const record = err as Record<string, unknown>;
  if (record.status === 404) return true;

  const message = err instanceof Error ? err.message : String(err);
  return /\bHTTP 404\b/i.test(message) || /not found/i.test(message);
}

async function fetchThreadStatus(threadId: string): Promise<ThreadLookupResult> {
  const client = getLangGraphClient();

  try {
    const thread = await client.threads.get(threadId);
    const status = thread?.status;

    if (typeof status !== "string" || !KNOWN_THREAD_STATUSES.has(status as ThreadStatus)) {
      throw new Error(`Unexpected thread status for ${threadId}`);
    }

    return { threadId, status: status as ThreadStatus };
  } catch (err) {
    if (isThreadNotFoundError(err)) {
      return { threadId, status: "missing" };
    }
    throw err;
  }
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
