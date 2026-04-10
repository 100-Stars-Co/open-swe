import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { escapeTelegramHtml, sendTelegramMessage } from "../src/utils/telegram.js";

const ORIGINAL_ENV = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
};

const ORIGINAL_FETCH = globalThis.fetch;

const state = {
  calls: [] as Array<{ url: string; body: Record<string, unknown> }>,
  attempt: 0,
};

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Promise<{ json: () => Promise<unknown> }>,
): void {
  globalThis.fetch = handler as typeof fetch;
}

describe("telegram send helper", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    state.calls = [];
    state.attempt = 0;
  });

  afterEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_ENV.TELEGRAM_BOT_TOKEN;
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("uses reply_parameters instead of reply_to_message_id", async () => {
    installFetchMock(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      state.calls.push({ url: String(_url), body });
      return {
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      };
    });

    const result = await sendTelegramMessage(123, "Hello", {
      replyParameters: {
        messageId: 99,
        allowSendingWithoutReply: false,
      },
      messageThreadId: 7,
      parseMode: "HTML",
    });

    expect(result.ok).toBe(true);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.body).toEqual({
      chat_id: 123,
      text: "Hello",
      parse_mode: "HTML",
      reply_parameters: {
        message_id: 99,
        allow_sending_without_reply: false,
      },
      message_thread_id: 7,
    });
  });

  it("falls back to escaped HTML when Telegram rejects the markup", async () => {
    installFetchMock(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      state.calls.push({ url: String(_url), body });
      state.attempt += 1;

      if (state.attempt === 1) {
        return {
          json: async () => ({
            ok: false,
            description: "Bad Request: can't parse entities: Character '<' is reserved",
          }),
        };
      }

      return {
        json: async () => ({ ok: true, result: { message_id: 2 } }),
      };
    });

    const result = await sendTelegramMessage(123, "5 < 6 & 7", {
      parseMode: "HTML",
      escapeHtmlOnParseError: true,
    });

    expect(result.ok).toBe(true);
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1]?.body.text).toBe("5 &lt; 6 &amp; 7");
  });

  it("escapes Telegram HTML entities", () => {
    expect(escapeTelegramHtml("<b>Fish & Chips</b>")).toBe("&lt;b&gt;Fish &amp; Chips&lt;/b&gt;");
  });
});
