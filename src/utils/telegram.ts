/**
 * Telegram Bot API utilities.
 * Mirrors agent/utils/telegram.py
 */

import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { extractRepoFromTextFull } from "./repo.js";
import { getTraceUrl } from "./tracing.js";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_REPO_OWNER = process.env.TELEGRAM_REPO_OWNER ?? "";
const TELEGRAM_REPO_NAME = process.env.TELEGRAM_REPO_NAME ?? "";

function telegramApiUrl(method: string): string {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is not set");
  }
  return `${TELEGRAM_API_BASE_URL}/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

/**
 * Verify the X-Telegram-Bot-Api-Secret-Token header.
 * Telegram sends this header verbatim (no HMAC), so we do a constant-time
 * string comparison to avoid timing attacks.
 */
export function verifyTelegramSecret(
  token: string,
  expectedSecret: string,
): boolean {
  if (!expectedSecret) {
    console.warn(
      "TELEGRAM_WEBHOOK_SECRET is not configured — rejecting webhook request",
    );
    return false;
  }
  if (!token) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expectedSecret));
  } catch {
    return false;
  }
}

/**
 * Generate a deterministic LangGraph thread ID from a Telegram chat.
 * For standard chats, uses chat_id alone. For forum group topics,
 * uses chat_id + message_thread_id.
 */
export function generateThreadIdFromTelegramChat(
  chatId: number,
  messageThreadId?: number,
): string {
  const composite =
    messageThreadId !== undefined
      ? `telegram:${chatId}:${messageThreadId}`
      : `telegram:${chatId}`;

  const md5Hex = createHash("md5").update(composite).digest("hex");
  const h = md5Hex.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20, 32),
  ].join("-");
}

/**
 * Send a message to a Telegram chat.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  options?: {
    replyToMessageId?: number;
    messageThreadId?: number;
    parseMode?: string;
  },
): Promise<Record<string, unknown>> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error(
      "TELEGRAM_BOT_TOKEN is not set — cannot send Telegram message",
    );
    return { ok: false, error: "TELEGRAM_BOT_TOKEN not configured" };
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: options?.parseMode ?? "HTML",
  };
  if (options?.replyToMessageId !== undefined) {
    payload.reply_to_message_id = options.replyToMessageId;
  }
  if (options?.messageThreadId !== undefined) {
    payload.message_thread_id = options.messageThreadId;
  }

  try {
    const response = await fetch(telegramApiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    const data = (await response.json()) as Record<string, unknown>;
    if (!data.ok) {
      console.warn(
        `Telegram sendMessage failed: ${(data.description as string) ?? "unknown error"}`,
      );
    }
    return data;
  } catch (err) {
    console.error(`Error sending Telegram message to chat ${chatId}:`, err);
    return { ok: false, error: "Request failed" };
  }
}

/**
 * Remove the @bot_username mention from text.
 */
export function stripBotMention(text: string, botUsername: string): string {
  if (!text) return "";
  if (!botUsername) return text.trim();
  return text.replace(`@${botUsername}`, "").trim();
}

/**
 * Check if the bot is @mentioned in a message.
 */
export function isBotMentioned(text: string, botUsername: string): boolean {
  if (!text || !botUsername) return false;
  return text.includes(`@${botUsername}`);
}

/**
 * Resolve repository configuration from Telegram message text.
 */
export function getTelegramRepoConfig(
  text?: string,
  defaultOwner?: string,
  defaultName?: string,
): { owner: string; name: string } {
  const ownerDefault = defaultOwner || TELEGRAM_REPO_OWNER;
  const nameDefault = defaultName || TELEGRAM_REPO_NAME;

  if (text) {
    const repoConfig = extractRepoFromTextFull(text, ownerDefault);
    if (repoConfig) return repoConfig;
  }

  return { owner: ownerDefault, name: nameDefault };
}

/**
 * Post a trace URL reply to a Telegram chat for observability.
 */
export async function postTelegramTraceReply(
  chatId: number,
  runId: string,
  messageThreadId?: number,
): Promise<void> {
  const traceUrl = getTraceUrl(runId);
  if (!traceUrl) return;

  const text = `🔗 <a href="${traceUrl}">View trace</a>`;
  await sendTelegramMessage(chatId, text, {
    messageThreadId,
    parseMode: "HTML",
  });
}
