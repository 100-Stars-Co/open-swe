/**
 * fetch_url tool — fetches a URL and converts HTML to Markdown.
 * Mirrors agent/tools/fetch_url.py
 */

import { tool } from "@langchain/core/tools";
import TurndownService from "turndown";
import { z } from "zod";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

const schema = z.object({
  url: z.string().url().describe("The URL to fetch."),
  timeout: z
    .number()
    .int()
    .positive()
    .default(30)
    .optional()
    .describe("Request timeout in seconds. Default: 30."),
});

export const fetchUrl = tool(
  async ({ url, timeout = 30 }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; OpenSWE/1.0; +https://github.com/langchain-ai/open-swe)",
        },
        redirect: "follow",
      });

      clearTimeout(timer);

      const contentType = response.headers.get("content-type") ?? "";
      const rawContent = await response.text();
      const contentLength = rawContent.length;

      let markdownContent: string;
      if (contentType.includes("text/html")) {
        markdownContent = turndown.turndown(rawContent);
      } else {
        markdownContent = rawContent;
      }

      // Truncate very large responses
      const MAX_CHARS = 50_000;
      const truncated = markdownContent.length > MAX_CHARS;
      if (truncated) {
        markdownContent =
          markdownContent.slice(0, MAX_CHARS) +
          "\n\n[Content truncated — use http_request to fetch specific sections]";
      }

      return JSON.stringify({
        url,
        markdown_content: markdownContent,
        status_code: response.status,
        content_length: contentLength,
        truncated,
      });
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message, url, status: "error" });
    }
  },
  {
    name: "fetch_url",
    description:
      "Fetch the content of a URL and return it as Markdown. " +
      "Use this to read documentation, GitHub pages, issue trackers, or any public webpage. " +
      "HTML is automatically converted to Markdown. Plain text and JSON are returned as-is.",
    schema,
  },
);
