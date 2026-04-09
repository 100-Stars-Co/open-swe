/**
 * http_request tool — generic HTTP client with SSRF protection.
 * Mirrors agent/tools/http_request.py
 *
 * Blocks requests to non-public IP ranges (RFC 1918, loopback, link-local)
 * to prevent server-side request forgery attacks.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

// RFC 1918 + loopback + link-local CIDRs to block
const BLOCKED_PREFIXES = [
  "10.",
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
  "192.168.",
  "127.",
  "169.254.",
  "::1",
  "fc",
  "fd",
];

function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "metadata.google.internal" ||
    BLOCKED_PREFIXES.some((p) => lower.startsWith(p))
  );
}

const schema = z.object({
  url: z.string().url().describe("The full URL to send the request to."),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    .default("GET")
    .optional()
    .describe("HTTP method. Default: GET."),
  headers: z
    .record(z.string())
    .optional()
    .describe("Optional HTTP request headers as key/value pairs."),
  body: z
    .string()
    .optional()
    .describe("Optional request body. For JSON payloads, pass a JSON-encoded string."),
  params: z
    .record(z.string())
    .optional()
    .describe("Optional URL query parameters as key/value pairs."),
  timeout: z
    .number()
    .int()
    .positive()
    .default(30)
    .optional()
    .describe("Timeout in seconds. Default: 30."),
});

export const httpRequest = tool(
  async ({ url, method = "GET", headers, body, params, timeout = 30 }) => {
    try {
      // SSRF guard
      const parsed = new URL(url);
      if (isBlockedHost(parsed.hostname)) {
        return JSON.stringify({
          error: `Requests to ${parsed.hostname} are blocked for security reasons.`,
          status: "error",
        });
      }

      // Append query params
      let finalUrl = url;
      if (params && Object.keys(params).length > 0) {
        const searchParams = new URLSearchParams(params);
        finalUrl = `${url}${url.includes("?") ? "&" : "?"}${searchParams}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout * 1000);

      let response: Response;
      try {
        response = await fetch(finalUrl, {
          method,
          headers,
          body: body ?? undefined,
          signal: controller.signal,
          redirect: "follow",
        });
      } finally {
        clearTimeout(timer);
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const content = await response.text();
      const truncated = content.length > 100_000;

      return JSON.stringify({
        success: response.ok,
        status_code: response.status,
        headers: responseHeaders,
        content: truncated ? content.slice(0, 100_000) + "\n[truncated]" : content,
        truncated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message, status: "error" });
    }
  },
  {
    name: "http_request",
    description:
      "Make an HTTP request to any public URL and return the response. " +
      "Useful for calling REST APIs, checking endpoint status, or fetching raw data. " +
      "Private IP addresses and localhost are blocked. " +
      "For reading and rendering web pages, prefer fetch_url instead.",
    schema,
  },
);
