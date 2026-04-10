/**
 * Utilities for building multimodal content blocks.
 * Mirrors agent/utils/multimodal.py
 */

const IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
const IMAGE_URL_RE = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|bmp|tiff)(?:\?[^\s)]+)?)/gi;

const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Extract image URLs from markdown image syntax and direct image links.
 */
export function extractImageUrls(text: string): string[] {
  if (!text) return [];

  const urls: string[] = [];

  for (const match of text.matchAll(IMAGE_MARKDOWN_RE)) {
    urls.push(match[1]);
  }
  for (const match of text.matchAll(IMAGE_URL_RE)) {
    urls.push(match[1]);
  }

  return dedupeUrls(urls);
}

/**
 * Fetch image bytes and build an image content block for LLM consumption.
 */
export async function fetchImageBlock(
  imageUrl: string,
): Promise<{ type: "image_url"; image_url: { url: string } } | null> {
  try {
    const headers: Record<string, string> = {};
    const host = new URL(imageUrl).hostname.toLowerCase();

    if (host === "uploads.linear.app" || host.endsWith(".uploads.linear.app")) {
      const linearApiKey = process.env.LINEAR_API_KEY ?? "";
      if (linearApiKey) {
        headers.Authorization = linearApiKey;
      }
    }

    const response = await fetch(imageUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.warn(`Failed to fetch image from ${imageUrl}: HTTP ${response.status}`);
      return null;
    }

    let contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!contentType) {
      // Guess from URL extension
      const ext = imageUrl.split("?")[0].split(".").pop()?.toLowerCase();
      const mimeMap: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
      };
      contentType = (ext && mimeMap[ext]) ?? "";
    }

    if (!SUPPORTED_TYPES.has(contentType)) {
      console.warn(`Unsupported content type '${contentType}' for ${imageUrl}; skipping`);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    return {
      type: "image_url",
      image_url: { url: `data:${contentType};base64,${base64}` },
    };
  } catch (err) {
    console.error(`Failed to fetch image from ${imageUrl}:`, err);
    return null;
  }
}

/**
 * Remove duplicate URLs while preserving order.
 */
export function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }
  return result;
}
