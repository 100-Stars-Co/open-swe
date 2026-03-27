/**
 * Fernet-compatible symmetric encryption using AES-128-CBC + HMAC-SHA256.
 *
 * Implements the Fernet specification (https://github.com/fernet/spec/blob/master/Spec.md)
 * so tokens encrypted here can be decrypted by the Python `cryptography.fernet` library.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

const FERNET_VERSION = 0x80;

/** Derive signing key (first 16 bytes) and encryption key (last 16 bytes) from the 32-byte Fernet key. */
function deriveKeys(fernetKey: Buffer): { signingKey: Buffer; encryptionKey: Buffer } {
  if (fernetKey.length !== 32) {
    throw new Error(`Fernet key must be 32 bytes, got ${fernetKey.length}`);
  }
  return {
    signingKey: fernetKey.subarray(0, 16),
    encryptionKey: fernetKey.subarray(16, 32),
  };
}

function getKey(): Buffer {
  const keyB64 = config.tokenEncryptionKey;
  if (!keyB64) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

/** Apply PKCS7 padding to a block. */
function pkcs7Pad(data: Buffer, blockSize = 16): Buffer {
  const pad = blockSize - (data.length % blockSize);
  const padded = Buffer.alloc(data.length + pad);
  data.copy(padded);
  padded.fill(pad, data.length);
  return padded;
}

/** Remove PKCS7 padding. */
function pkcs7Unpad(data: Buffer): Buffer {
  if (data.length === 0) throw new Error("Empty data");
  const pad = data[data.length - 1] as number;
  if (pad < 1 || pad > 16) throw new Error("Invalid PKCS7 padding");
  return data.subarray(0, data.length - pad);
}

/**
 * Encrypt a plaintext string using Fernet.
 * Returns a URL-safe base64-encoded Fernet token (compatible with Python's cryptography.fernet).
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext) return "";

  const fernetKey = getKey();
  const { signingKey, encryptionKey } = deriveKeys(fernetKey);

  const iv = randomBytes(16);
  const now = BigInt(Math.floor(Date.now() / 1000));

  const timestampBuf = Buffer.alloc(8);
  // Write big-endian uint64
  timestampBuf.writeBigUInt64BE(now);

  const padded = pkcs7Pad(Buffer.from(plaintext, "utf-8"));
  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);

  // HMAC over: version || timestamp || iv || ciphertext
  const versionBuf = Buffer.from([FERNET_VERSION]);
  const hmacInput = Buffer.concat([versionBuf, timestampBuf, iv, ciphertext]);
  const mac = createHmac("sha256", signingKey).update(hmacInput).digest();

  const token = Buffer.concat([hmacInput, mac]);
  return token.toString("base64url");
}

/**
 * Decrypt a Fernet token.
 * Returns the plaintext string, or "" if decryption fails.
 */
export function decryptToken(fernetToken: string): string {
  if (!fernetToken) return "";

  try {
    const fernetKey = getKey();
    const { signingKey, encryptionKey } = deriveKeys(fernetKey);

    const tokenBuf = Buffer.from(fernetToken, "base64url");
    if (tokenBuf.length < 1 + 8 + 16 + 32) throw new Error("Token too short");

    const version = tokenBuf[0] as number;
    if (version !== FERNET_VERSION) throw new Error(`Unsupported Fernet version: ${version}`);

    const macStart = tokenBuf.length - 32;
    const hmacInput = tokenBuf.subarray(0, macStart);
    const providedMac = tokenBuf.subarray(macStart);

    const expectedMac = createHmac("sha256", signingKey).update(hmacInput).digest();
    if (!timingSafeEqual(providedMac, expectedMac)) throw new Error("Invalid HMAC");

    const iv = tokenBuf.subarray(9, 25);
    const ciphertext = tokenBuf.subarray(25, macStart);

    const decipher = createDecipheriv("aes-128-cbc", encryptionKey, iv);
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const plaintext = pkcs7Unpad(padded);
    return plaintext.toString("utf-8");
  } catch {
    return "";
  }
}
