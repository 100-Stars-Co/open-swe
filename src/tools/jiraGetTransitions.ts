/**
 * jira_get_transitions tool
 * Mirrors agent/tools/jira_get_transitions.py
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getTransitions } from "../utils/jira.js";

export const jiraGetTransitions = tool(
  async ({ issueKey }) => {
    try {
      const result = await getTransitions(issueKey);
      return JSON.stringify({ success: true, transitions: result });
    } catch (err) {
      return JSON.stringify({ error: String(err), status: "error" });
    }
  },
  {
    name: "jira_get_transitions",
    description:
      "Get the available status transitions for a Jira issue. " +
      "Use jira_transition_issue with the returned transition ID to change the status.",
    schema: z.object({
      issueKey: z.string().describe("The Jira issue key, e.g. 'PROJ-123'."),
    }),
  },
);
