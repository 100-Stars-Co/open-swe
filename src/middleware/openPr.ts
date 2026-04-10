/**
 * Open PR safety net middleware — fires once after the agent loop finishes.
 * Mirrors agent/middleware/open_pr.py
 *
 * If the agent completed without calling commit_and_open_pr (or the tool failed),
 * this middleware checks for uncommitted changes and opens a PR automatically.
 */

import { type AIMessage, ToolMessage } from "@langchain/core/messages";
import type { SandboxBackendProtocol } from "deepagents";
import { createMiddleware } from "langchain";
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

export const openPrIfNeededMiddleware = createMiddleware({
  name: "OpenPrIfNeeded",
  afterAgent: async (state) => {
    const configurable = (state as Record<string, unknown>).configurable as
      | Record<string, unknown>
      | undefined;
    const threadId = configurable?.thread_id as string | undefined;
    const repo = configurable?.repo as { owner: string; name: string } | undefined;
    const issueNumber = configurable?.issue_number as number | undefined;

    if (!threadId || !repo) return {};

    const messages =
      ((state as Record<string, unknown>).messages as (AIMessage | ToolMessage)[]) ?? [];

    // Check if commit_and_open_pr was already called successfully
    const prAlreadyCreated = messages.some(
      (m) =>
        m instanceof ToolMessage &&
        m.name === "commit_and_open_pr" &&
        (() => {
          try {
            const parsed = JSON.parse(
              typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            ) as Record<string, unknown>;
            return parsed.success === true;
          } catch {
            return false;
          }
        })(),
    );

    if (prAlreadyCreated) return {};

    const sandbox = getSandboxBackend(threadId) as SandboxBackendProtocol | undefined;
    if (!sandbox) return {};

    const { repoDir: persistedRepoDir } = await getSandboxMetadata(threadId);
    const repoDir = persistedRepoDir ?? resolveSandboxRepoDir(repo.owner, repo.name);

    try {
      const [token] = await resolveGithubTokenForMiddleware(threadId);

      const hasChanges = await gitHasUncommittedChanges(sandbox, repoDir);
      const hasUnpushed = await gitHasUnpushedCommits(sandbox, repoDir);

      if (!hasChanges && !hasUnpushed) return {};

      await gitConfigUser(sandbox, repoDir, "Open SWE Bot", "openswe@users.noreply.github.com");

      let branch = await gitCurrentBranch(sandbox, repoDir);
      const defaultBranch = await getGithubDefaultBranch(repo.owner, repo.name, token);

      if (branch === defaultBranch || branch === "HEAD") {
        const branchName = generateBranchName("auto-pr", issueNumber ?? Date.now());
        await gitCheckoutBranch(sandbox, repoDir, branchName);
        branch = branchName;
      }

      if (hasChanges) {
        await gitAddAll(sandbox, repoDir);
        await gitCommit(sandbox, repoDir, "chore: auto-commit by open-swe safety net");
      }

      await gitPush(sandbox, repoDir, branch, token, repo.owner, repo.name);

      await createGithubPr(
        repo.owner,
        repo.name,
        branch,
        defaultBranch,
        `[Open SWE] Auto PR — issue #${issueNumber ?? "?"}`,
        "This PR was automatically created by the Open SWE safety net. " +
          "The agent completed but did not call `commit_and_open_pr` explicitly.",
        token,
        true,
      );
    } catch (err) {
      console.error("[openPrIfNeeded] Safety net PR creation failed:", err);
    }

    return {};
  },
});

async function resolveGithubTokenForMiddleware(
  threadId: string,
): Promise<
  [string, string | null, ReturnType<typeof import("../utils/auth.js")["resolveGithubToken"]>]
> {
  const { resolveGithubToken } = await import("../utils/auth.js");
  const [token, encrypted] = await resolveGithubToken({}, threadId);
  return [token, encrypted, null as unknown as ReturnType<typeof resolveGithubToken>];
}
