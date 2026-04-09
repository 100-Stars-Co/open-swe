/**
 * Model factory — mirrors agent/utils/model.py.
 *
 * Returns a pre-configured chat model instance for providers that need
 * extra options (e.g. Ollama base URL), or the raw model-ID string for
 * all other providers so that deepagents / initChatModel can handle them.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * Build a chat model from a provider:model string.
 *
 * - `ollama:<model>` — returns a `ChatOllama` instance, using
 *   `OLLAMA_BASE_URL` env var as the base URL when set.
 * - anything else — returns the string unchanged so that
 *   `createDeepAgent` / `initChatModel` can resolve it.
 */
export async function makeModel(
  modelId: string,
  options: Record<string, unknown> = {},
): Promise<BaseChatModel | string> {
  if (modelId.startsWith("ollama:")) {
    const { ChatOllama } = await import("@langchain/ollama");
    const ollamaModel = modelId.slice("ollama:".length);
    const baseUrl = process.env.OLLAMA_BASE_URL;
    return new ChatOllama({
      model: ollamaModel,
      ...(baseUrl ? { baseUrl } : {}),
      ...options,
    });
  }

  return modelId;
}
