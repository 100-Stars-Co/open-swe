/**
 * github_comment tool — post a comment on a GitHub issue or PR.
 * Mirrors agent/tools/github_comment.py
 */

import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { postGithubComment } from "../utils/github.js";
import { resolveGithubToken } from "../utils/auth.js";

const schema = z.object({
  message: z
    .string()
    .describe("The comment body. Markdown is supported."),
  issueNumber: z
    .number()
    .int()
    .optional()
    .describe(
      "Issue or PR number to comment on. Defaults to the current issue from thread context.",
    ),
});

export const githubComment = tool(
  async ({ message, issueNumber }, config: RunnableConfig) => {
    const configurable = config?.configurable ?? {};
    const threadId = configurable.thread_id as string;
    const repo = configurable.repo as { owner: string; name: string } | undefined;
    const contextIssueNumber = configurable.issue_number as number | undefined;

    const targetIssue = issueNumber ?? contextIssueNumber;
    if (!repo || !targetIssue) {
      return JSON.stringify({
        error: "repo and issue_number must be configured in thread context",
        status: "error",
      });
    }

    try {
      const [token] = await resolveGithubToken({}, threadId);
      await postGithubComment(repo.owner, repo.name, targetIssue, message, token);
      return JSON.stringify({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: msg, status: "error" });
    }
  },
  {
    name: "github_comment",
    description:
      "Post a comment on a GitHub issue or pull request. " +
      "Use this to report progress, ask for clarification, or post the final summary. " +
      "Markdown is supported.",
    schema,
  },
);
