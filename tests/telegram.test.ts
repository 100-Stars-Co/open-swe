import { describe, expect, it } from "bun:test";
import {
  generateThreadIdFromTelegramChat,
  getTelegramRepoConfig,
  isBotMentioned,
  stripBotMention,
  verifyTelegramSecret,
} from "../src/utils/telegram.js";

describe("generateThreadIdFromTelegramChat", () => {
  it("is deterministic", () => {
    const chatId = 123456789;
    expect(generateThreadIdFromTelegramChat(chatId)).toBe(generateThreadIdFromTelegramChat(chatId));
  });

  it("returns a UUID-length string", () => {
    expect(generateThreadIdFromTelegramChat(123456789).length).toBe(36);
  });

  it("produces different IDs for different chat_ids", () => {
    expect(generateThreadIdFromTelegramChat(1)).not.toBe(generateThreadIdFromTelegramChat(2));
  });

  it("differs with message_thread_id", () => {
    const chatId = 999;
    const without = generateThreadIdFromTelegramChat(chatId);
    const with42 = generateThreadIdFromTelegramChat(chatId, 42);
    expect(without).not.toBe(with42);
  });

  it("is deterministic with topic", () => {
    const chatId = 111;
    expect(generateThreadIdFromTelegramChat(chatId, 7)).toBe(
      generateThreadIdFromTelegramChat(chatId, 7),
    );
  });
});

describe("verifyTelegramSecret", () => {
  it("returns true for matching secret", () => {
    expect(verifyTelegramSecret("my-secret", "my-secret")).toBe(true);
  });

  it("returns false for non-matching secret", () => {
    expect(verifyTelegramSecret("wrong", "my-secret")).toBe(false);
  });

  it("returns false for empty token", () => {
    expect(verifyTelegramSecret("", "my-secret")).toBe(false);
  });

  it("returns false for empty expected", () => {
    expect(verifyTelegramSecret("my-secret", "")).toBe(false);
  });
});

describe("isBotMentioned", () => {
  it("returns true when bot is mentioned", () => {
    expect(isBotMentioned("Hey @mybot help me out", "mybot")).toBe(true);
  });

  it("returns false when bot is not mentioned", () => {
    expect(isBotMentioned("Just a regular message", "mybot")).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(isBotMentioned("", "mybot")).toBe(false);
  });

  it("returns false for empty username", () => {
    expect(isBotMentioned("Hello @mybot", "")).toBe(false);
  });
});

describe("stripBotMention", () => {
  it("removes mention from text", () => {
    const result = stripBotMention("@mybot please help with this", "mybot");
    expect(result).not.toContain("@mybot");
    expect(result).toContain("please help with this");
  });

  it("returns empty for empty text", () => {
    expect(stripBotMention("", "mybot")).toBe("");
  });

  it("returns original when no mention", () => {
    expect(stripBotMention("just a normal message", "mybot")).toBe("just a normal message");
  });
});

describe("getTelegramRepoConfig", () => {
  it("extracts repo from inline directive", () => {
    const config = getTelegramRepoConfig(
      "repo:myorg/myrepo please fix the bug",
      "fallback-org",
      "fallback-repo",
    );
    expect(config.owner).toBe("myorg");
    expect(config.name).toBe("myrepo");
  });

  it("falls back to defaults when no directive", () => {
    const config = getTelegramRepoConfig("just a normal message", "default-org", "default-repo");
    expect(config.owner).toBe("default-org");
    expect(config.name).toBe("default-repo");
  });
});
