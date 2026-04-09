/**
 * Tool error handler middleware.
 * Mirrors agent/middleware/tool_error_handler.py
 *
 * Wraps every tool call and catches exceptions, returning a structured JSON
 * error payload instead of crashing the agent loop. This lets the LLM see
 * the error and self-correct or retry.
 */

import { createMiddleware } from "langchain";
import { ToolMessage } from "@langchain/core/messages";

export const toolErrorHandlerMiddleware = createMiddleware({
  name: "ToolErrorHandler",
  wrapToolCall: async (request, handler) => {
    try {
      return await handler(request);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const payload = JSON.stringify({
        error: error.message,
        error_type: error.constructor.name,
        status: "error",
        name: request.toolCall.name,
      });
      return new ToolMessage({
        content: payload,
        tool_call_id: request.toolCall.id ?? "",
        name: request.toolCall.name,
        status: "error",
      });
    }
  },
});
