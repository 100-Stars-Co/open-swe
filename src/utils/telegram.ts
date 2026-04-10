/**
 * Telegram Bot API utilities.
 * Mirrors agent/utils/telegram.py
 */

import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { extractRepoFromTextFull } from "./repo.js";
import { getTraceUrl } from "./tracing.js";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

function getTelegramBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN ?? "";
}

function getTelegramRepoOwner(): string {
  return process.env.TELEGRAM_REPO_OWNER ?? "";
}

function getTelegramRepoName(): string {
  return process.env.TELEGRAM_REPO_NAME ?? "";
}

function telegramApiUrl(method: string): string {
  const token = getTelegramBotToken();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is not set");
  }
  return `${TELEGRAM_API_BASE_URL}/bot${token}/${method}`;
}

/**
 * Verify the X-Telegram-Bot-Api-Secret-Token header.
 * Telegram sends this header verbatim (no HMAC), so we do a constant-time
 * string comparison to avoid timing attacks.
 */
export function verifyTelegramSecret(token: string, expectedSecret: string): boolean {
  if (!expectedSecret) {
    console.warn("TELEGRAM_WEBHOOK_SECRET is not configured — rejecting webhook request");
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
export function generateThreadIdFromTelegramChat(chatId: number, messageThreadId?: number): string {
  const composite =
    messageThreadId !== undefined ? `telegram:${chatId}:${messageThreadId}` : `telegram:${chatId}`;

  const md5Hex = createHash("md5").update(composite).digest("hex");
  const h = md5Hex.slice(0, 32);
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join(
    "-",
  );
}

export interface TelegramReplyParameters {
  messageId: number;
  allowSendingWithoutReply?: boolean;
}

export interface SendTelegramMessageOptions {
  replyParameters?: TelegramReplyParameters;
  replyToMessageId?: number;
  messageThreadId?: number;
  parseMode?: string | null;
  escapeHtmlOnParseError?: boolean;
}

export function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isTelegramHtmlParseError(description?: string): boolean {
  if (!description) return false;
  return /can't parse entities|entity.*byte|tag.*not allowed|can't find end tag|unsupported start tag/i.test(
    description,
  );
}

async function postTelegramMessage(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(telegramApiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  return (await response.json()) as Record<string, unknown>;
}

/**
 * Send a message to a Telegram chat.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  options?: SendTelegramMessageOptions,
): Promise<Record<string, unknown>> {
  const token = getTelegramBotToken();
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set — cannot send Telegram message");
    return { ok: false, error: "TELEGRAM_BOT_TOKEN not configured" };
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (options?.parseMode !== undefined && options.parseMode !== null) {
    payload.parse_mode = options.parseMode;
  }
  const replyParameters =
    options?.replyParameters ??
    (options?.replyToMessageId !== undefined
      ? {
          messageId: options.replyToMessageId,
          allowSendingWithoutReply: true,
        }
      : undefined);
  if (replyParameters) {
    payload.reply_parameters = {
      message_id: replyParameters.messageId,
      allow_sending_without_reply: replyParameters.allowSendingWithoutReply ?? true,
    };
  }
  if (options?.messageThreadId !== undefined) {
    payload.message_thread_id = options.messageThreadId;
  }

  try {
    const data = await postTelegramMessage(payload);
    if (!data.ok) {
      const description = (data.description as string) ?? "unknown error";
      if (
        options?.escapeHtmlOnParseError &&
        payload.parse_mode === "HTML" &&
        isTelegramHtmlParseError(description)
      ) {
        const escapedPayload = {
          ...payload,
          text: escapeTelegramHtml(text),
        };
        const retryData = await postTelegramMessage(escapedPayload);
        if (!retryData.ok) {
          console.warn(
            `Telegram sendMessage failed after HTML fallback: ${
              (retryData.description as string) ?? "unknown error"
            }`,
          );
        }
        return retryData;
      }

      console.warn(`Telegram sendMessage failed: ${description}`);
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
  const ownerDefault = defaultOwner || getTelegramRepoOwner();
  const nameDefault = defaultName || getTelegramRepoName();

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
