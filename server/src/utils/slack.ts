/**
 * Slack API utilities.
 * Ports agent/utils/slack.py to TypeScript.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { getTraceUrl } from "./tracing.ts";

const SLACK_API_BASE = "https://slack.com/api";

function slackHeaders(): Record<string, string> {
  if (!config.slackBotToken) return {};
  return {
    Authorization: `Bearer ${config.slackBotToken}`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

function parseTs(ts: string | undefined): number {
  const n = parseFloat(ts ?? "0");
  return isNaN(n) ? 0 : n;
}

function extractSlackUserName(user: Record<string, unknown>): string {
  const profile = user["profile"];
  if (profile && typeof profile === "object") {
    const p = profile as Record<string, unknown>;
    const displayName = typeof p["display_name"] === "string" ? p["display_name"].trim() : "";
    if (displayName) return displayName;
    const realName = typeof p["real_name"] === "string" ? p["real_name"].trim() : "";
    if (realName) return realName;
  }
  const realName = typeof user["real_name"] === "string" ? user["real_name"].trim() : "";
  if (realName) return realName;
  const name = typeof user["name"] === "string" ? user["name"].trim() : "";
  if (name) return name;
  return "unknown";
}

/** Verify Slack request signature (v0 HMAC-SHA256). */
export function verifySlackSignature(
  body: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  maxAgeSeconds = 300,
): boolean {
  if (!secret || !timestamp || !signature) return false;
  const requestTimestamp = parseInt(timestamp, 10);
  if (isNaN(requestTimestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - requestTimestamp) > maxAgeSeconds) return false;

  const baseString = `v0:${timestamp}:${body.toString("utf-8")}`;
  const expected = "v0=" + createHmac("sha256", secret).update(baseString).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Replace Slack bot ID mention token with @username. */
export function replaceBotMentionWithUsername(
  text: string,
  botUserId: string,
  botUsername: string,
): string {
  if (!text) return "";
  if (botUserId && botUsername) {
    return text.replace(new RegExp(`<@${botUserId}>`, "g"), `@${botUsername}`);
  }
  return text;
}

/** Remove bot mention token from Slack text. */
export function stripBotMention(text: string, botUserId: string, botUsername = ""): string {
  if (!text) return "";
  let stripped = text;
  if (botUserId) stripped = stripped.replace(new RegExp(`<@${botUserId}>`, "g"), "");
  if (botUsername) stripped = stripped.replace(new RegExp(`@${botUsername}`, "g"), "");
  return stripped.trim();
}

export interface SlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  username?: string;
  files?: Array<{ mimetype?: string; url_private?: string }>;
}

/** Select context messages from a Slack thread. */
export function selectSlackContextMessages(
  messages: SlackMessage[],
  currentMessageTs: string,
  botUserId: string,
  botUsername = "",
): [SlackMessage[], string] {
  if (!messages.length) return [[], "thread_start"];

  const currentTs = parseTs(currentMessageTs);
  const ordered = [...messages].sort((a, b) => parseTs(a.ts) - parseTs(b.ts));
  const upToCurrent = ordered.filter((m) => parseTs(m.ts) <= currentTs);
  const msgs = upToCurrent.length ? upToCurrent : ordered;

  const mentionTokens: string[] = [];
  if (botUserId) mentionTokens.push(`<@${botUserId}>`);
  if (botUsername) mentionTokens.push(`@${botUsername}`);

  if (!mentionTokens.length) return [msgs, "thread_start"];

  let lastMentionIndex = -1;
  for (let i = 0; i < msgs.length - 1; i++) {
    const text = msgs[i]?.text ?? "";
    if (mentionTokens.some((token) => text.includes(token))) {
      lastMentionIndex = i;
    }
  }

  if (lastMentionIndex >= 0) return [msgs.slice(lastMentionIndex), "last_mention"];
  return [msgs, "thread_start"];
}

/** Format Slack messages into readable prompt text. */
export function formatSlackMessagesForPrompt(
  messages: SlackMessage[],
  userNamesById: Record<string, string> = {},
  botUserId = "",
  botUsername = "",
): string {
  if (!messages.length) return "(no thread messages available)";

  return messages
    .map((message) => {
      const text =
        replaceBotMentionWithUsername(message.text ?? "", botUserId, botUsername).trim() ||
        "[non-text message]";
      if (typeof message.user === "string" && message.user) {
        const authorName = userNamesById[message.user] ?? message.user;
        return `@${authorName}(${message.user}): ${text}`;
      }
      const botName =
        (typeof message.bot_profile === "object"
          ? (message.bot_profile as { name?: string } | null)?.name
          : null) ??
        message.username ??
        "Bot";
      return `@${botName}(bot): ${text}`;
    })
    .join("\n");
}

/** Post a reply in a Slack thread. */
export async function postSlackThreadReply(
  channelId: string,
  threadTs: string,
  text: string,
): Promise<boolean> {
  if (!config.slackBotToken) return false;
  try {
    const response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: slackHeaders(),
      body: JSON.stringify({ channel: channelId, thread_ts: threadTs, text }),
    });
    const data = (await response.json()) as { ok?: boolean; error?: string };
    if (!data.ok) {
      console.warn("Slack chat.postMessage failed:", data.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Slack chat.postMessage request failed:", err);
    return false;
  }
}

/** Post a trace URL reply in a Slack thread. */
export async function postSlackTraceReply(
  channelId: string,
  threadTs: string,
  runId: string,
): Promise<void> {
  const traceUrl = getTraceUrl(runId);
  if (traceUrl) {
    await postSlackThreadReply(channelId, threadTs, `Working on it! <${traceUrl}|View trace>`);
  }
}

/** Add a reaction emoji to a Slack message. */
export async function addSlackReaction(
  channelId: string,
  messageTs: string,
  emoji = "eyes",
): Promise<boolean> {
  if (!config.slackBotToken) return false;
  try {
    const response = await fetch(`${SLACK_API_BASE}/reactions.add`, {
      method: "POST",
      headers: slackHeaders(),
      body: JSON.stringify({ channel: channelId, timestamp: messageTs, name: emoji }),
    });
    const data = (await response.json()) as { ok?: boolean; error?: string };
    if (data.ok || data.error === "already_reacted") return true;
    console.warn("Slack reactions.add failed:", data.error);
    return false;
  } catch (err) {
    console.error("Slack reactions.add request failed:", err);
    return false;
  }
}

/** Get Slack user info by user ID. */
export async function getSlackUserInfo(
  userId: string,
): Promise<Record<string, unknown> | null> {
  if (!config.slackBotToken) return null;
  try {
    const url = new URL(`${SLACK_API_BASE}/users.info`);
    url.searchParams.set("user", userId);
    const response = await fetch(url.toString(), { headers: slackHeaders() });
    const data = (await response.json()) as { ok?: boolean; user?: unknown; error?: string };
    if (!data.ok) {
      console.warn("Slack users.info failed:", data.error);
      return null;
    }
    return typeof data.user === "object" ? (data.user as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Get display names for a set of Slack user IDs. */
export async function getSlackUserNames(userIds: string[]): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))].sort();
  if (!uniqueIds.length) return {};

  const infos = await Promise.allSettled(uniqueIds.map((id) => getSlackUserInfo(id)));
  const result: Record<string, string> = {};
  uniqueIds.forEach((userId, i) => {
    const info = infos[i];
    if (info?.status === "fulfilled" && info.value) {
      result[userId] = extractSlackUserName(info.value);
    } else {
      result[userId] = userId;
    }
  });
  return result;
}

/** Fetch all messages in a Slack thread. */
export async function fetchSlackThreadMessages(
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  if (!config.slackBotToken) return [];
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  while (true) {
    const url = new URL(`${SLACK_API_BASE}/conversations.replies`);
    url.searchParams.set("channel", channelId);
    url.searchParams.set("ts", threadTs);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);

    try {
      const response = await fetch(url.toString(), { headers: slackHeaders() });
      const payload = (await response.json()) as {
        ok?: boolean;
        messages?: unknown[];
        error?: string;
        response_metadata?: { next_cursor?: string };
      };

      if (!payload.ok) {
        console.warn("Slack conversations.replies failed:", payload.error);
        break;
      }

      const batch = payload.messages ?? [];
      for (const item of batch) {
        if (typeof item === "object" && item !== null) {
          messages.push(item as SlackMessage);
        }
      }

      cursor = payload.response_metadata?.next_cursor;
      if (!cursor) break;
    } catch (err) {
      console.error("Slack conversations.replies request failed:", err);
      break;
    }
  }

  messages.sort((a, b) => parseTs(a.ts) - parseTs(b.ts));
  return messages;
}
