import { describe, expect, it } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { Command, isCommand } from "@langchain/langgraph";
import { toolErrorHandlerMiddleware } from "../src/middleware/toolErrorHandler.js";

const mockRequest = {
  toolCall: { id: "call_1", name: "test_tool", args: {} },
  tool: {} as never,
  state: {} as never,
  runtime: {} as never,
} as Parameters<NonNullable<typeof toolErrorHandlerMiddleware.wrapToolCall>>[0];

describe("toolErrorHandlerMiddleware", () => {
  it("wraps object tool results into string ToolMessages", async () => {
    const result = await toolErrorHandlerMiddleware.wrapToolCall?.(mockRequest, (async () => ({
      ok: true,
      nested: { value: 1 },
    })) as never);

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toBe(
      JSON.stringify({ ok: true, nested: { value: 1 } }),
    );
  });

  it("normalizes non-string ToolMessage content", async () => {
    const result = await toolErrorHandlerMiddleware.wrapToolCall?.(
      mockRequest,
      (async () =>
        new ToolMessage({
          tool_call_id: "call_1",
          name: "test_tool",
          content: [{ type: "text", text: "hello" }],
        })) as never,
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toBe(JSON.stringify([{ type: "text", text: "hello" }]));
  });

  it("preserves Command responses", async () => {
    const command = new Command({ goto: "agent" });
    const result = await toolErrorHandlerMiddleware.wrapToolCall?.(
      mockRequest,
      (async () => command) as never,
    );

    expect(isCommand(result)).toBe(true);
    expect(result).toBe(command);
  });
});
