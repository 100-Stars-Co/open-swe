/**
 * jira_update_issue tool
 * Mirrors agent/tools/jira_update_issue.py
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { updateIssue } from "../utils/jira.js";

export const jiraUpdateIssue = tool(
  async ({ issueKey, summary, description, priority, assignee, labels }) => {
    try {
      await updateIssue({ issueKey, summary, description, priority, assignee, labels });
      return JSON.stringify({ success: true });
    } catch (err) {
      return JSON.stringify({ error: String(err), status: "error" });
    }
  },
  {
    name: "jira_update_issue",
    description: "Update fields on an existing Jira issue.",
    schema: z.object({
      issueKey: z.string().describe("The Jira issue key, e.g. 'PROJ-123'."),
      summary: z.string().optional().describe("New issue title."),
      description: z.string().optional().describe("New issue description (plain text)."),
      priority: z.string().optional().describe("New priority name, e.g. 'High'."),
      assignee: z.string().optional().describe("New assignee account ID."),
      labels: z.array(z.string()).optional().describe("New label list (replaces existing)."),
    }),
  },
);
