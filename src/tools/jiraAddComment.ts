/**
 * jira_add_comment tool
 * Mirrors agent/tools/jira_add_comment.py
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { addComment } from "../utils/jira.js";

export const jiraAddComment = tool(
  async ({ issueKey, comment }) => {
    try {
      const result = await addComment(issueKey, comment);
      return JSON.stringify({ success: true, comment: result });
    } catch (err) {
      return JSON.stringify({ error: String(err), status: "error" });
    }
  },
  {
    name: "jira_add_comment",
    description: "Add a comment to a Jira issue. Use this to report progress or post the PR link.",
    schema: z.object({
      issueKey: z.string().describe("The Jira issue key, e.g. 'PROJ-123'."),
      comment: z.string().describe("Comment body (plain text)."),
    }),
  },
);
