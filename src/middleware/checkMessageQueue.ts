/**
 * Check message queue middleware — fires before every model call.
 * Mirrors agent/middleware/check_message_queue.py
 *
 * If other webhook events arrived while this agent run was busy, they are stored
 * in the LangGraph store under namespace ("queue", thread_id). This middleware
 * reads the FIFO queue and injects any pending messages as new human turns.
 */

import { createMiddleware } from "langchain";
import { Client } from "@langchain/langgraph-sdk";
import { HumanMessage } from "@langchain/core/messages";

const QUEUE_NAMESPACE_PREFIX = "queue";
const QUEUE_KEY = "pending_messages";

export const checkMessageQueueMiddleware = createMiddleware({
  name: "CheckMessageQueue",
  beforeModel: async (state) => {
    const threadId = (state as Record<string, unknown>).thread_id as string | undefined;
    if (!threadId) return {};

    try {
      const client = new Client({
        apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024",
      });

      const item = await client.store.getItem([QUEUE_NAMESPACE_PREFIX, threadId], QUEUE_KEY);
      if (!item?.value) return {};

      const pending = item.value as { messages: string[] };
      if (!pending.messages?.length) return {};

      // Delete the queue atomically before injecting (prevents duplicates)
      await client.store.deleteItem([QUEUE_NAMESPACE_PREFIX, threadId], QUEUE_KEY);

      // Inject each queued message as a human turn
      const injectedMessages = pending.messages.map(
        (content) => new HumanMessage(content),
      );

      const currentMessages = ((state as Record<string, unknown>).messages as HumanMessage[]) ?? [];
      return { messages: [...currentMessages, ...injectedMessages] };
    } catch {
      // Non-fatal — store may not be configured or queue may be empty
      return {};
    }
  },
});

/**
 * Queue a message for a busy thread — called by the webhook handler.
 */
export async function queueMessageForThread(threadId: string, message: string): Promise<void> {
  const client = new Client({
    apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024",
  });

  // Read existing queue and append
  let existing: string[] = [];
  try {
    const item = await client.store.getItem([QUEUE_NAMESPACE_PREFIX, threadId], QUEUE_KEY);
    existing = (item?.value as { messages: string[] })?.messages ?? [];
  } catch {
    // Queue doesn't exist yet
  }

  await client.store.putItem([QUEUE_NAMESPACE_PREFIX, threadId], QUEUE_KEY, {
    messages: [...existing, message],
  });
}
