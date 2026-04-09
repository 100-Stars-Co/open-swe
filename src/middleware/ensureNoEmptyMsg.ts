/**
 * Ensure no empty message middleware — fires after every model call.
 * Mirrors agent/middleware/ensure_no_empty_msg.py
 *
 * If the model returns a response with no text and no tool calls, the agent
 * would stall. This middleware injects a no_op tool call to keep the loop alive.
 */

import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

export const ensureNoEmptyMsgMiddleware = createMiddleware({
  name: "EnsureNoEmptyMsg",
  afterModel: async (state) => {
    const messages = ((state as Record<string, unknown>).messages as AIMessage[]) ?? [];
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || !(lastMessage instanceof AIMessage)) return {};

    const hasContent =
      typeof lastMessage.content === "string"
        ? lastMessage.content.trim().length > 0
        : (lastMessage.content as unknown[]).length > 0;

    const hasToolCalls = Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0;

    if (!hasContent && !hasToolCalls) {
      // Inject a no_op tool call to keep the loop running
      const noOpId = `no_op_${Date.now()}`;
      const updatedMessage = new AIMessage({
        content: lastMessage.content,
        tool_calls: [
          {
            id: noOpId,
            name: "no_op",
            args: {},
            type: "tool_call",
          },
        ],
      });

      const toolResponseMessage = new ToolMessage({
        content:
          "Please continue with the task, ensuring you ALWAYS call at least one tool per turn.",
        tool_call_id: noOpId,
        name: "no_op",
      });

      return {
        messages: [...messages.slice(0, -1), updatedMessage, toolResponseMessage],
      };
    }

    return {};
  },
});
