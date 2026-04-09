/**
 * Helpers for normalizing message content across model providers.
 * Mirrors agent/utils/messages.py
 */

/**
 * Extract human-readable text from model message content.
 *
 * Supports:
 * - Plain strings
 * - OpenAI-style content blocks (list of {type: "text", text: ...})
 * - Dict wrappers with nested "content" or "text"
 */
export function extractTextContent(content: string | unknown[]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const item of content) {
    if (typeof item === "object" && item !== null && "text" in item) {
      text += (item as { text: string }).text;
    }
  }
  return text.trim();
}
