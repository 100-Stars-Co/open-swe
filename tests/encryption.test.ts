import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { encryptToken, decryptToken, EncryptionKeyMissingError } from "../src/encryption.js";
import { randomBytes } from "node:crypto";

describe("encryption", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.TOKEN_ENCRYPTION_KEY;
    // Set a valid 32-byte key for each test
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it("round-trips a plain string", () => {
    const token = "ghp_mySecretGitHubToken12345";
    const encrypted = encryptToken(token);
    expect(decryptToken(encrypted)).toBe(token);
  });

  it("round-trips an empty string", () => {
    const encrypted = encryptToken("");
    expect(decryptToken(encrypted)).toBe("");
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const token = "same-token";
    const a = encryptToken(token);
    const b = encryptToken(token);
    expect(a).not.toBe(b);
    // Both should decrypt to the same value
    expect(decryptToken(a)).toBe(token);
    expect(decryptToken(b)).toBe(token);
  });

  it("returns empty string for tampered ciphertext", () => {
    const token = "valid-token";
    const encrypted = encryptToken(token);
    // Flip a byte in the middle of the base64
    const buf = Buffer.from(encrypted, "base64");
    buf[20] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(decryptToken(tampered)).toBe("");
  });

  it("returns empty string for garbage input", () => {
    expect(decryptToken("not-valid-base64!!!")).toBe("");
    expect(decryptToken("")).toBe("");
  });

  it("throws EncryptionKeyMissingError when TOKEN_ENCRYPTION_KEY is not set", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken("anything")).toThrow(EncryptionKeyMissingError);
  });

  it("throws when key is wrong length", () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(16).toString("base64"); // 16 bytes, not 32
    expect(() => encryptToken("anything")).toThrow(/32 bytes/);
  });
});
