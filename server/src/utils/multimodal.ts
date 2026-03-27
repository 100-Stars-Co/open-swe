/**
 * Multimodal content block utilities.
 * Ports agent/utils/multimodal.py to TypeScript.
 */

import { config } from "./config.ts";

const IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
const IMAGE_URL_RE = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|bmp|tiff)(?:\?[^\s)]+)?)/gi;

/** Extract image URLs from markdown image syntax and direct image links. */
export function extractImageUrls(text: string): string[] {
  if (!text) return [];
  const urls: string[] = [];
  for (const match of text.matchAll(IMAGE_MARKDOWN_RE)) {
    if (match[1]) urls.push(match[1]);
  }
  for (const match of text.matchAll(IMAGE_URL_RE)) {
    if (match[1]) urls.push(match[1]);
  }
  return dedupeUrls(urls);
}

/** Deduplicate a list of URLs, preserving order. */
export function dedupeUrls(urls: string[]): string[] {
  return [...new Map(urls.map((u) => [u, u])).values()];
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Fetch an image and build an image content block.
 * Returns null if the image cannot be fetched or has an unsupported MIME type.
 */
export async function fetchImageBlock(imageUrl: string): Promise<ImageBlock | null> {
  try {
    const headers: Record<string, string> = {};
    const urlObj = new URL(imageUrl);
    const host = urlObj.hostname.toLowerCase();

    if (host === "uploads.linear.app" || host.endsWith(".uploads.linear.app")) {
      if (config.linearApiKey) {
        headers["Authorization"] = config.linearApiKey;
      }
    } else if (host === "files.slack.com" || host.endsWith(".files.slack.com")) {
      if (config.slackBotToken) {
        headers["Authorization"] = `Bearer ${config.slackBotToken}`;
      }
    }

    const response = await fetch(imageUrl, { headers, redirect: "follow" });
    if (!response.ok) return null;

    let contentType = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim() ?? "";

    if (!contentType) {
      // Try to guess from URL extension
      const ext = urlObj.pathname.split(".").pop()?.toLowerCase();
      const guessMap: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
      };
      contentType = (ext && guessMap[ext]) || "";
    }

    if (!SUPPORTED_MIME_TYPES.has(contentType)) return null;

    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer).toString("base64");
    return {
      type: "image",
      source: { type: "base64", media_type: contentType, data },
    };
  } catch {
    return null;
  }
}
