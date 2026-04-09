/**
 * jira_search_issues tool
 * Mirrors agent/tools/jira_search_issues.py
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { searchIssues } from "../utils/jira.js";

export const jiraSearchIssues = tool(
  async ({ jql }) => {
    try {
      const result = await searchIssues(jql);
      return JSON.stringify({ success: true, ...result });
    } catch (err) {
      return JSON.stringify({ error: String(err), status: "error" });
    }
  },
  {
    name: "jira_search_issues",
    description:
      "Search Jira issues using JQL (Jira Query Language). " +
      "Example: 'project = PROJ AND status = \"In Progress\" ORDER BY created DESC'",
    schema: z.object({
      jql: z.string().describe("A valid JQL query string."),
    }),
  },
);
