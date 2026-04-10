/**
 * Tool error handler middleware.
 * Mirrors agent/middleware/tool_error_handler.py
 *
 * Wraps every tool call and catches exceptions, returning a structured JSON
 * error payload instead of crashing the agent loop. This lets the LLM see
 * the error and self-correct or retry.
 */

import { ToolMessage } from "@langchain/core/messages";
import { isCommand } from "@langchain/langgraph";
import { createMiddleware } from "langchain";

function stringifyToolContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const toolErrorHandlerMiddleware = createMiddleware({
  name: "ToolErrorHandler",
  wrapToolCall: async (request, handler) => {
    try {
      const response = await handler(request);

      if (isCommand(response)) return response;

      if (response instanceof ToolMessage) {
        response.content = stringifyToolContent(response.content);
        return response;
      }

      return new ToolMessage({
        content: stringifyToolContent(response),
        tool_call_id: request.toolCall.id ?? "",
        name: request.toolCall.name,
      });
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
