/**
 * jira_get_issue tool
 * Mirrors agent/tools/jira_get_issue.py
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getIssue } from "../utils/jira.js";

export const jiraGetIssue = tool(
  async ({ issueKey }) => {
    try {
      const issue = await getIssue(issueKey);
      return JSON.stringify({ success: true, issue });
    } catch (err) {
      return JSON.stringify({ error: String(err), status: "error" });
    }
  },
  {
    name: "jira_get_issue",
    description: "Get the details of a Jira issue by its key (e.g. 'PROJ-123').",
    schema: z.object({
      issueKey: z.string().describe("The Jira issue key, e.g. 'PROJ-123'."),
    }),
  },
);
