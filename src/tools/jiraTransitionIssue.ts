/**
 * jira_transition_issue tool
 * Mirrors agent/tools/jira_transition_issue.py
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { transitionIssue } from "../utils/jira.js";

export const jiraTransitionIssue = tool(
  async ({ issueKey, transitionId, comment }) => {
    try {
      await transitionIssue(issueKey, transitionId, comment);
      return JSON.stringify({ success: true });
    } catch (err) {
      return JSON.stringify({ error: String(err), status: "error" });
    }
  },
  {
    name: "jira_transition_issue",
    description:
      "Transition a Jira issue to a new status using a transition ID. " +
      "Use jira_get_transitions first to get the available transition IDs.",
    schema: z.object({
      issueKey: z.string().describe("The Jira issue key, e.g. 'PROJ-123'."),
      transitionId: z.string().describe("The transition ID from jira_get_transitions."),
      comment: z
        .string()
        .optional()
        .describe("Optional comment to add when transitioning."),
    }),
  },
);
