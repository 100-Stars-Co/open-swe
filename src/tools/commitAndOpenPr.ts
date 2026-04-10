/**
 * commit_and_open_pr tool — commits all changes in the sandbox and opens a GitHub draft PR.
 * Mirrors agent/tools/commit_and_open_pr.py
 *
 * This is the primary "submit work" tool that the agent calls when done.
 * The open_pr middleware acts as a safety net if the agent forgets to call it.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import type { SandboxBackendProtocol } from "deepagents";
import { z } from "zod";
import { resolveGithubToken } from "../utils/auth.js";
import { generateBranchName } from "../utils/extract.js";
import {
  createGithubPr,
  getGithubDefaultBranch,
  gitAddAll,
  gitCheckoutBranch,
  gitCommit,
  gitConfigUser,
  gitCurrentBranch,
  gitHasUncommittedChanges,
  gitHasUnpushedCommits,
  gitPush,
} from "../utils/github.js";
import { resolveSandboxRepoDir } from "../utils/repoDir.js";
import { getSandboxBackend, getSandboxMetadata } from "../utils/sandboxState.js";

const schema = z.object({
  title: z.string().describe("The pull request title. Should be concise and descriptive."),
  body: z
    .string()
    .describe("The pull request description. Use markdown. Include a summary of changes made."),
  commitMessage: z
    .string()
    .optional()
    .describe("Optional custom git commit message. Defaults to the PR title if not provided."),
});

export const commitAndOpenPr = tool(
  async ({ title, body, commitMessage }, config: RunnableConfig) => {
    const configurable = (config as RunnableConfig)?.configurable ?? {};
    const threadId = configurable.thread_id as string;
    const repo = configurable.repo as { owner: string; name: string } | undefined;
    const issueNumber = configurable.issue_number as number | undefined;

    if (!repo) {
      return JSON.stringify({
        error: "No repo configured in thread config",
        status: "error",
      });
    }

    const sandbox = getSandboxBackend(threadId) as SandboxBackendProtocol;
    if (!sandbox) {
      return JSON.stringify({
        error: "No sandbox found for this thread",
        status: "error",
      });
    }

    try {
      const [token] = await resolveGithubToken({}, threadId);
      const { repoDir: persistedRepoDir } = await getSandboxMetadata(threadId);
      const repoDir = persistedRepoDir ?? resolveSandboxRepoDir(repo.owner, repo.name);

      // Configure git identity
      await gitConfigUser(sandbox, repoDir, "Open SWE Bot", "openswe@users.noreply.github.com");

      // Determine / create branch
      let branch = await gitCurrentBranch(sandbox, repoDir);
      const defaultBranch = await getGithubDefaultBranch(repo.owner, repo.name, token);

      if (branch === defaultBranch || branch === "HEAD") {
        // Need a new branch
        const branchName = generateBranchName(title, issueNumber ?? Date.now());
        await gitCheckoutBranch(sandbox, repoDir, branchName);
        branch = branchName;
      }

      // Stage and commit
      const hasChanges = await gitHasUncommittedChanges(sandbox, repoDir);
      if (hasChanges) {
        await gitAddAll(sandbox, repoDir);
        const message = commitMessage ?? title;
        const commitResult = await gitCommit(sandbox, repoDir, message);
        if (commitResult.exitCode !== 0) {
          return JSON.stringify({
            error: commitResult.output,
            status: "error",
          });
        }
      }

      // Push
      const hasPushed = hasChanges || (await gitHasUnpushedCommits(sandbox, repoDir));
      if (hasPushed) {
        const pushResult = await gitPush(sandbox, repoDir, branch, token, repo.owner, repo.name);
        if (pushResult.exitCode !== 0) {
          return JSON.stringify({ error: pushResult.output, status: "error" });
        }
      }

      // Create / find PR
      const pr = await createGithubPr(
        repo.owner,
        repo.name,
        branch,
        defaultBranch,
        title,
        body,
        token,
        true, // draft
      );

      return JSON.stringify({
        success: true,
        pr_url: pr.html_url,
        pr_number: pr.number,
        branch,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message, status: "error" });
    }
  },
  {
    name: "commit_and_open_pr",
    description:
      "Commit all changes in the sandbox and open a GitHub draft pull request. " +
      "Call this when you have finished implementing the task. " +
      "Provide a clear title and detailed PR description in Markdown.",
    schema,
  },
);
