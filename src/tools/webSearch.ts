/**
 * web_search tool — web search via Exa API.
 * Mirrors agent/tools/web_search.py
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

const EXA_API_BASE = "https://api.exa.ai";

const schema = z.object({
  query: z.string().describe("The search query."),
  numResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .optional()
    .describe("Number of results to return. Default: 5."),
  includeContents: z
    .boolean()
    .default(true)
    .optional()
    .describe("Whether to include the webpage contents in results. Default: true."),
});

export const webSearch = tool(
  async ({ query, numResults = 5, includeContents = true }) => {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      return JSON.stringify({
        error: "EXA_API_KEY not configured",
        status: "error",
      });
    }

    try {
      const response = await fetch(`${EXA_API_BASE}/search`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          numResults,
          contents: includeContents ? { text: { maxCharacters: 2000 } } : undefined,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return JSON.stringify({
          error: `Exa API error (${response.status}): ${text}`,
          status: "error",
        });
      }

      const data = await response.json();
      return JSON.stringify({ success: true, results: data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message, status: "error" });
    }
  },
  {
    name: "web_search",
    description:
      "Search the web for information using the Exa API. " +
      "Returns a list of relevant URLs with titles and optional page content. " +
      "Use this to find documentation, library releases, error solutions, or any public information.",
    schema,
  },
);
