/**
 * Agent server — main LangGraph entry point.
 * Mirrors agent/server.py
 *
 * getAgent() is called by the LangGraph runtime for each invocation.
 * It resolves the GitHub token, creates/reconnects the sandbox, clones
 * the target repo, reads AGENTS.md, and returns a configured DeepAgent.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { createDeepAgent } from "deepagents";
import { resolveGithubToken, persistEncryptedGithubToken } from "./utils/auth.js";
import { readAgentsMd } from "./utils/agentsMd.js";
import {
  getSandboxBackend,
  setSandboxBackend,
  getSandboxMetadata,
  setSandboxMetadata,
  waitForSandboxId,
  SANDBOX_CREATING,
} from "./utils/sandboxState.js";
import { createSandbox } from "./utils/sandbox.js";
import {
  isValidGitRepo,
  removeDirectory,
  setupGitCredentials,
  cleanupGitCredentials,
  gitFetchOrigin,
  gitPullBranch,
  gitCurrentBranch,
  gitCheckoutBranch,
} from "./utils/github.js";
import { constructSystemPrompt } from "./prompt.js";
import {
  commitAndOpenPr,
  fetchUrl,
  httpRequest,
  webSearch,
  githubComment,
  listPrReviews,
  getPrReview,
  createPrReview,
  submitPrReview,
  dismissPrReview,
  listPrReviewComments,
  jiraGetIssue,
  jiraSearchIssues,
  jiraCreateIssue,
  jiraUpdateIssue,
  jiraAddComment,
  jiraGetTransitions,
  jiraTransitionIssue,
} from "./tools/index.js";
import {
  toolErrorHandlerMiddleware,
  checkMessageQueueMiddleware,
  ensureNoEmptyMsgMiddleware,
  openPrIfNeededMiddleware,
  cleanupSandboxMiddleware,
} from "./middleware/index.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LLM_MODEL_ID =
  process.env.DEEPAGENTS_MODEL ?? "anthropic:claude-opus-4-6";
const DEFAULT_RECURSION_LIMIT = 1_000; // reserved for future use
void DEFAULT_RECURSION_LIMIT;
const SANDBOX_CREATION_TIMEOUT_MS = 180_000; // 3 minutes

// ─── Repo / config types ──────────────────────────────────────────────────────

interface RepoConfig {
  owner: string;
  name: string;
}

interface AgentConfigurable {
  thread_id: string;
  repo?: RepoConfig;
  source?: "github" | "jira";
  issue_number?: number;
  base_branch?: string;
  jira_project_key?: string;
  jira_issue_key?: string;
}

// ─── Main factory ─────────────────────────────────────────────────────────────

/**
 * Build a configured DeepAgent for a given thread.
 * Called by the LangGraph runtime on every invocation.
 */
// biome-ignore lint/suspicious/noExplicitAny: DeepAgent return type references internal pnpm paths
export async function getAgent(config: RunnableConfig): Promise<any> {
  const configurable = (config.configurable ?? {}) as AgentConfigurable;
  const { thread_id: threadId, repo, base_branch: baseBranch } = configurable;

  if (!threadId) throw new Error("thread_id is required in config.configurable");
  if (!repo?.owner || !repo?.name) {
    throw new Error("repo.owner and repo.name are required in config.configurable");
  }

  // 1. Resolve GitHub token
  const [token, encryptedToken] = await resolveGithubToken({}, threadId);
  if (encryptedToken) {
    await persistEncryptedGithubToken(threadId, encryptedToken);
  }

  // 2. Get or create sandbox
  const sandbox = await getOrCreateSandbox(threadId);

  // 3. Clone or pull repo
  const repoDir = `/home/user/repos/${repo.owner}/${repo.name}`;
  await cloneOrPullRepo(sandbox, repo, repoDir, token, baseBranch);

  // 4. Store repo_dir in metadata so middleware can access it
  await setSandboxMetadata(threadId, { repoDir });

  // 5. Read AGENTS.md / CLAUDE.md
  const agentsMdResult = await readAgentsMd(sandbox, repoDir);

  // 6. Build system prompt
  const systemPrompt = constructSystemPrompt({
    workingDir: repoDir,
    jiraProjectKey: configurable.jira_project_key,
    jiraIssueKey: configurable.jira_issue_key,
    agentsMd: agentsMdResult?.content,
    agentsMdFilename: agentsMdResult?.filename,
  });

  // 7. Tool list
  const tools = [
    // Core
    fetchUrl,
    httpRequest,
    webSearch,
    commitAndOpenPr,
    // GitHub
    githubComment,
    listPrReviews,
    getPrReview,
    createPrReview,
    submitPrReview,
    dismissPrReview,
    listPrReviewComments,
    // Jira
    jiraGetIssue,
    jiraSearchIssues,
    jiraCreateIssue,
    jiraUpdateIssue,
    jiraAddComment,
    jiraGetTransitions,
    jiraTransitionIssue,
  ];

  // 8. Middleware stack
  const middleware = [
    toolErrorHandlerMiddleware,
    checkMessageQueueMiddleware,
    ensureNoEmptyMsgMiddleware,
    openPrIfNeededMiddleware,
    cleanupSandboxMiddleware,
  ];

  // 9. Create and return agent
  return createDeepAgent({
    model: DEFAULT_LLM_MODEL_ID,
    // biome-ignore lint/suspicious/noExplicitAny: tool types vary across langchain versions
    tools: tools as any[],
    // biome-ignore lint/suspicious/noExplicitAny: middleware types vary by deepagents version
    middleware: middleware as any[],
    systemPrompt,
    backend: sandbox,
  });
}

// ─── Sandbox lifecycle ────────────────────────────────────────────────────────

async function getOrCreateSandbox(threadId: string) {
  // Check in-process cache first
  const cached = getSandboxBackend(threadId);
  if (cached) return cached;

  // Check thread metadata for persisted sandbox ID
  const meta = await getSandboxMetadata(threadId);

  let sandboxId = meta.sandboxId;

  if (sandboxId === SANDBOX_CREATING) {
    // Another invocation is creating the sandbox — wait for it
    sandboxId = await waitForSandboxId(threadId, SANDBOX_CREATION_TIMEOUT_MS);
    if (!sandboxId) {
      throw new Error("Timed out waiting for sandbox to be created by concurrent invocation");
    }
  }

  if (!sandboxId) {
    // Mark as creating to prevent concurrent creates
    await setSandboxMetadata(threadId, { sandboxId: SANDBOX_CREATING });
  }

  try {
    const sandbox = await createSandbox(sandboxId ?? undefined);
    setSandboxBackend(threadId, sandbox);

    // Verify the sandbox is responsive
    const probe = await sandbox.execute("echo ok");
    if (probe.exitCode !== 0) throw new Error("Sandbox health check failed");

    // Persist the new sandbox ID
    if (!sandboxId) {
      const newId = (sandbox as unknown as { id: string }).id;
      if (newId) {
        await setSandboxMetadata(threadId, { sandboxId: newId });
      }
    }

    return sandbox;
  } catch (err) {
    // Clear CREATING sentinel on failure so next invocation retries
    if (!sandboxId) {
      await setSandboxMetadata(threadId, { sandboxId: "" }).catch(() => {});
    }
    throw err;
  }
}

// ─── Repo clone / pull ────────────────────────────────────────────────────────

async function cloneOrPullRepo(
  // biome-ignore lint/suspicious/noExplicitAny: sandbox type varies
  sandbox: any,
  repo: RepoConfig,
  repoDir: string,
  token: string,
  baseBranch?: string,
): Promise<void> {
  const valid = await isValidGitRepo(sandbox, repoDir);

  if (valid) {
    // Repo already cloned — pull latest
    await setupGitCredentials(sandbox, token);
    try {
      await gitFetchOrigin(sandbox, repoDir);
      const branch = baseBranch ?? (await gitCurrentBranch(sandbox, repoDir));
      await gitPullBranch(sandbox, repoDir, branch, token);
    } finally {
      await cleanupGitCredentials(sandbox);
    }
    return;
  }

  // Fresh clone
  const repoParentDir = `/home/user/repos/${repo.owner}`;
  await sandbox.execute(`mkdir -p ${shellQuote(repoParentDir)}`);
  await removeDirectory(sandbox, repoDir);

  const cloneUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`;
  const cloneResult = await sandbox.execute(
    `git clone ${shellQuote(cloneUrl)} ${shellQuote(repoDir)} 2>&1`,
  );
  if (cloneResult.exitCode !== 0) {
    throw new Error(`Failed to clone repository: ${cloneResult.output}`);
  }

  // Checkout base branch if specified
  if (baseBranch) {
    await gitCheckoutBranch(sandbox, repoDir, baseBranch);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
