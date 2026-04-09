/**
 * telegram_reply tool — send a message to the current Telegram chat.
 * Mirrors agent/tools/telegram_reply.py
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { sendTelegramMessage } from "../utils/telegram.js";

const schema = z.object({
  message: z
    .string()
    .describe(
      "The HTML-formatted message to send to the Telegram chat. " +
        "Use <b>bold</b>, <i>italic</i>, <code>code</code>, <pre>block</pre>, " +
        '<a href="url">link</a>. Avoid Markdown syntax.',
    ),
});

export const telegramReply = tool(
  async ({ message }, config: RunnableConfig) => {
    const configurable = config?.configurable ?? {};
    const telegramChat = (configurable.telegram_chat ?? {}) as Record<
      string,
      unknown
    >;

    const chatId = telegramChat.chat_id as number | undefined;
    const replyToMessageId = telegramChat.reply_to_message_id as
      | number
      | undefined;
    const messageThreadId = telegramChat.message_thread_id as
      | number
      | undefined;

    if (!chatId) {
      return JSON.stringify({
        success: false,
        error: "Missing telegram_chat.chat_id in config",
      });
    }

    if (!message.trim()) {
      return JSON.stringify({
        success: false,
        error: "Message cannot be empty",
      });
    }

    const result = await sendTelegramMessage(chatId, message, {
      replyToMessageId,
      messageThreadId,
      parseMode: "HTML",
    });

    return JSON.stringify({ success: result.ok === true });
  },
  {
    name: "telegram_reply",
    description:
      "Send a message to the current Telegram chat. " +
      "Format messages using Telegram HTML parse mode: <b>bold</b>, <i>italic</i>, " +
      '<code>code</code>, <pre>code block</pre>, <a href="url">link</a>. ' +
      "Use plain newlines for line breaks. Avoid Markdown syntax.",
    schema,
  },
);
