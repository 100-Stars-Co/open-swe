/**
 * Langfuse tracing integration for LangGraph.
 * Mirrors agent/integrations/langfuse_tracing.py
 *
 * See: https://langfuse.com/guides/cookbook/integration_langgraph
 * See: https://langfuse.com/docs/integrations/langchain
 */

// biome-ignore lint/suspicious/noExplicitAny: Langfuse types are loaded dynamically
let _langfuseClient: any | null = null;

/**
 * Get or create a Langfuse CallbackHandler for LangGraph tracing.
 *
 * Required env vars:
 *   LANGFUSE_PUBLIC_KEY  — Public API key
 *   LANGFUSE_SECRET_KEY  — Secret API key
 *
 * Optional:
 *   LANGFUSE_BASE_URL / LANGFUSE_HOST — Langfuse host (default: https://cloud.langfuse.com)
 *
 * Returns the handler instance if configured, `null` otherwise.
 */
// biome-ignore lint/suspicious/noExplicitAny: return type depends on langfuse package
export async function getLangfuseCallbackHandler(): Promise<any | null> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const host =
    process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) return null;

  try {
    const { Langfuse } = await import("langfuse");
    const { CallbackHandler } = await import("langfuse-langchain");

    const createdClient = !_langfuseClient;
    if (createdClient) {
      _langfuseClient = new Langfuse({ publicKey, secretKey, baseUrl: host });
    }
    const callbackHandler = new CallbackHandler({ publicKey, secretKey, baseUrl: host });

    if (createdClient) {
      console.log("[Langfuse] Langfuse client initialised");
    }
    return callbackHandler;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      console.warn(
        "[Langfuse] Package not installed. Install with: bun add langfuse langfuse-langchain",
      );
    } else {
      console.warn("[Langfuse] Failed to initialise callback handler:", err);
    }
    return null;
  }
}

/**
 * Get the Langfuse client instance (created lazily by getLangfuseCallbackHandler).
 */
// biome-ignore lint/suspicious/noExplicitAny: return type depends on langfuse package
export async function getLangfuseClient(): Promise<any | null> {
  if (!_langfuseClient) await getLangfuseCallbackHandler();
  return _langfuseClient;
}

/**
 * Apply Langfuse tracing callbacks to a runnable if tracing is configured.
 */
export async function withLangfuseTracing<
  T extends { withConfig?: (config: Record<string, unknown>) => unknown },
>(runnable: T): Promise<T> {
  const handler = await getLangfuseCallbackHandler();
  if (!handler || typeof runnable.withConfig !== "function") return runnable;
  return runnable.withConfig({ callbacks: [handler] }) as T;
}

/** Check if the minimum required env vars are set. */
export function isLangfuseConfigured(): boolean {
  return !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}
