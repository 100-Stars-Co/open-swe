/**
 * jira_create_issue tool
 * Mirrors agent/tools/jira_create_issue.py
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createIssue } from "../utils/jira.js";

export const jiraCreateIssue = tool(
  async ({ projectKey, summary, description, issueType, priority, assignee, labels }) => {
    try {
      const issue = await createIssue({
        projectKey,
        summary,
        description,
        issueType,
        priority,
        assignee,
        labels,
      });
      return JSON.stringify({ success: true, issue });
    } catch (err) {
      return JSON.stringify({ error: String(err), status: "error" });
    }
  },
  {
    name: "jira_create_issue",
    description: "Create a new Jira issue in a project.",
    schema: z.object({
      projectKey: z.string().describe("The Jira project key, e.g. 'PROJ'."),
      summary: z.string().describe("Issue title / summary."),
      description: z.string().optional().describe("Issue description (plain text)."),
      issueType: z
        .string()
        .optional()
        .default("Task")
        .describe("Issue type name. Default: 'Task'."),
      priority: z.string().optional().describe("Priority name, e.g. 'High', 'Medium'."),
      assignee: z.string().optional().describe("Assignee account ID."),
      labels: z.array(z.string()).optional().describe("Labels to apply to the issue."),
    }),
  },
);
