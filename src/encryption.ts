/**
 * Token encryption/decryption using AES-256-GCM.
 * Mirrors the behavior of agent/encryption.py (Python Fernet) but uses
 * Node.js built-in crypto — no external dependencies.
 *
 * Key format: 32-byte buffer encoded as base64 (URL-safe or standard).
 * Generate: node -e "const c=require('crypto');console.log(c.randomBytes(32).toString('base64'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

export class EncryptionKeyMissingError extends Error {
  constructor() {
    super(
      "TOKEN_ENCRYPTION_KEY environment variable is not set. " +
        "Generate one with: node -e \"const c=require('crypto');console.log(c.randomBytes(32).toString('base64'))\"",
    );
    this.name = "EncryptionKeyMissingError";
  }
}

function getEncryptionKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new EncryptionKeyMissingError();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
        "Re-generate with: node -e \"const c=require('crypto');console.log(c.randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

/**
 * Encrypt a plaintext token.
 * Output format (base64): IV (12 bytes) | ciphertext | auth tag (16 bytes)
 */
export function encryptToken(token: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/**
 * Decrypt a token previously encrypted with encryptToken().
 * Returns empty string on any failure (bad key, tampered ciphertext, etc.)
 * to match the Python implementation's behavior.
 */
export function decryptToken(encryptedToken: string): string {
  try {
    const key = getEncryptionKey();
    const buf = Buffer.from(encryptedToken, "base64");

    if (buf.length < IV_LENGTH + TAG_LENGTH + 1) return "";

    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(buf.length - TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
