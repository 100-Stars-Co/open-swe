/**
 * LangGraph SDK client helpers.
 * Wraps @langchain/langgraph-sdk for use in the webhook server.
 */

import { Client } from "@langchain/langgraph-sdk";
import { config } from "./config.ts";

/** Create a LangGraph SDK client pointing at LANGGRAPH_URL. */
export function getLangGraphClient(): Client {
  return new Client({ apiUrl: config.langgraphUrl });
}

/** Check if a LangGraph thread is currently active (status === "busy"). */
export async function isThreadActive(threadId: string): Promise<boolean> {
  const client = getLangGraphClient();
  try {
    const thread = await client.threads.get(threadId);
    return (thread as { status?: string }).status === "busy";
  } catch {
    return false;
  }
}

/** Return true if a LangGraph thread already exists. */
export async function threadExists(threadId: string): Promise<boolean> {
  const client = getLangGraphClient();
  try {
    await client.threads.get(threadId);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    console.warn("Failed to fetch thread", threadId, "— assuming it exists");
    return true;
  }
}

/** Persist the repo config on a thread's metadata (upsert). */
export async function upsertThreadRepoMetadata(
  threadId: string,
  repoConfig: { owner: string; name: string },
): Promise<void> {
  const client = getLangGraphClient();
  try {
    await client.threads.update(threadId, { metadata: { repo: repoConfig } });
  } catch (err) {
    if (isNotFoundError(err)) {
      try {
        await client.threads.create({ threadId, ifExists: "do_nothing", metadata: { repo: repoConfig } });
      } catch {
        console.error("Failed to create thread", threadId, "while persisting repo metadata");
      }
      return;
    }
    console.error("Failed to persist repo metadata for thread", threadId, err);
  }
}

export type MessageContent = string | Array<Record<string, unknown>> | Record<string, unknown>;

/**
 * Queue a message for an active thread (FIFO via LangGraph store).
 * Returns true if successfully queued.
 */
export async function queueMessageForThread(
  threadId: string,
  messageContent: MessageContent,
): Promise<boolean> {
  const client = getLangGraphClient();
  try {
    const namespace: [string, string] = ["queue", threadId];
    const key = "pending_messages";
    const newMessage = { content: messageContent };

    let existingMessages: Array<{ content: MessageContent }> = [];
    try {
      const existingItem = await client.store.getItem(namespace, key);
      const val = (existingItem as { value?: { messages?: Array<{ content: MessageContent }> } } | null)?.value;
      existingMessages = val?.messages ?? [];
    } catch {
      // No existing queued messages
    }

    existingMessages.push(newMessage);
    await client.store.putItem(namespace, key, { messages: existingMessages });
    return true;
  } catch (err) {
    console.error("Failed to queue message for thread", threadId, err);
    return false;
  }
}

/** True if an error looks like a LangGraph 404. */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { status_code?: number; statusCode?: number }).status_code
      ?? (err as { status_code?: number; statusCode?: number }).statusCode;
    if (code === 404) return true;
    const msg = (err as { message?: string }).message ?? "";
    if (msg.includes("404") || msg.toLowerCase().includes("not found")) return true;
  }
  return false;
}

/** Extract repo config from a thread's metadata. */
export function extractRepoConfigFromThread(
  thread: Record<string, unknown>,
): { owner: string; name: string } | null {
  const metadata = thread["metadata"];
  if (typeof metadata !== "object" || !metadata) return null;

  const meta = metadata as Record<string, unknown>;
  const repo = meta["repo"];
  if (typeof repo === "object" && repo !== null) {
    const r = repo as Record<string, unknown>;
    if (typeof r["owner"] === "string" && typeof r["name"] === "string" && r["owner"] && r["name"]) {
      return { owner: r["owner"], name: r["name"] };
    }
  }

  const owner = meta["repo_owner"];
  const name = meta["repo_name"];
  if (typeof owner === "string" && typeof name === "string" && owner && name) {
    return { owner, name };
  }

  return null;
}
