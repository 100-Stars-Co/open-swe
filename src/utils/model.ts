/**
 * Model factory — mirrors agent/utils/model.py.
 *
 * Returns a pre-configured chat model instance for providers that need
 * extra options (e.g. Ollama base URL) or for universal model strings.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { initChatModel } from "langchain";

/**
 * Build a chat model from a provider:model string.
 *
 * - `ollama:<model>` — returns a `ChatOllama` instance, using
 *   `OLLAMA_BASE_URL` env var as the base URL when set.
 * - anything else — resolves through LangChain's `initChatModel()`.
 */
export async function makeModel(
  modelId: string,
  options: Record<string, unknown> = {},
  callbacks: unknown[] = [],
): Promise<BaseChatModel> {
  const callbackOptions = callbacks.length ? ({ callbacks: callbacks as any } as const) : {};

  if (modelId.startsWith("ollama:")) {
    const { ChatOllama } = await import("@langchain/ollama");
    const ollamaModel = modelId.slice("ollama:".length);
    const baseUrl = process.env.OLLAMA_BASE_URL;
    return new ChatOllama({
      model: ollamaModel,
      ...(baseUrl ? { baseUrl } : {}),
      ...callbackOptions,
      ...options,
    }) as BaseChatModel;
  }

  return (await initChatModel(
    modelId,
    {
      ...callbackOptions,
      ...options,
    } as never,
  )) as BaseChatModel;
}
