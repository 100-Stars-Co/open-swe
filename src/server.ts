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
import { getLangfuseCallbackHandler } from "./integrations/langfuse.js";
import {
  checkMessageQueueMiddleware,
  cleanupSandboxMiddleware,
  ensureNoEmptyMsgMiddleware,
  openPrIfNeededMiddleware,
  toolErrorHandlerMiddleware,
  verifyPrAfterAgentMiddleware,
} from "./middleware/index.js";
import { constructSystemPrompt } from "./prompt.js";
import {
  commitAndOpenPr,
  createPrReview,
  dismissPrReview,
  fetchUrl,
  figmaExportImage,
  figmaGetComponent,
  figmaGetFile,
  getPrReview,
  githubComment,
  httpRequest,
  jiraAddComment,
  jiraCreateIssue,
  jiraGetIssue,
  jiraGetTransitions,
  jiraSearchIssues,
  jiraTransitionIssue,
  jiraUpdateIssue,
  listPrReviewComments,
  listPrReviews,
  submitPrReview,
  telegramReply,
  verifyPrTool,
  webSearch,
} from "./tools/index.js";
import { readAgentsMd } from "./utils/agentsMd.js";
import { persistEncryptedGithubToken, resolveGithubToken } from "./utils/auth.js";
import {
  cleanupGitCredentials,
  gitCheckoutBranch,
  gitCurrentBranch,
  gitFetchOrigin,
  gitPullBranch,
  isValidGitRepo,
  removeDirectory,
  setupGitCredentials,
} from "./utils/github.js";
import { makeModel } from "./utils/model.js";
import { resolveSandboxRepoDir } from "./utils/repoDir.js";
import { getOrCreateSandbox } from "./utils/sandboxLifecycle.js";
import { setSandboxMetadata } from "./utils/sandboxState.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LLM_MODEL_ID = process.env.DEEPAGENTS_MODEL ?? "anthropic:claude-opus-4-6";
const DEFAULT_RECURSION_LIMIT = 1_000; // reserved for future use
void DEFAULT_RECURSION_LIMIT;

const registeredTools = [
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
  // Telegram
  telegramReply,
  // Verification
  verifyPrTool,
];

// ─── Repo / config types ──────────────────────────────────────────────────────

interface RepoConfig {
  owner: string;
  name: string;
}

interface AgentConfigurable {
  thread_id: string;
  repo?: RepoConfig;
  source?: "github" | "jira" | "telegram";
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

  // We only require these if we are actually running the agent.
  // LangGraph calls this during schema generation/loading where they might be missing.
  if (!threadId || !repo?.owner || !repo?.name) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      // If we don't have an API key, we can't initialize the real agent.
      // We return a minimal StateGraph that defines the same structure
      // so the schema endpoints (GET /schemas) work correctly.
      const { StateGraph } = await import("@langchain/langgraph");
      const { Annotation } = await import("@langchain/langgraph");

      const Schema = Annotation.Root({
        messages: Annotation<unknown[]>({
          reducer: (x, y) => x.concat(y),
          default: () => [],
        }),
      });

      return new StateGraph(Schema).compile();
    }

    return createDeepAgent({
      tools: registeredTools,
      middleware: [],
    });
  }

  // 1. Resolve GitHub token
  const [token, encryptedToken] = await resolveGithubToken({}, threadId);
  if (encryptedToken) {
    await persistEncryptedGithubToken(threadId, encryptedToken);
  }

  // 2. Get or create sandbox
  const sandbox = await getOrCreateSandbox(threadId);

  // 3. Clone or pull repo
  const repoDir = resolveSandboxRepoDir(repo.owner, repo.name);
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
  const tools = [...registeredTools];

  // Figma tools — only include if FIGMA_API_KEY is set
  if (process.env.FIGMA_API_KEY) {
    // biome-ignore lint/suspicious/noExplicitAny: figma tools have different schemas
    (tools as any[]).push(figmaGetFile, figmaGetComponent, figmaExportImage);
  }

  // 8. Middleware stack
  const middleware = [
    toolErrorHandlerMiddleware,
    checkMessageQueueMiddleware,
    ensureNoEmptyMsgMiddleware,
    openPrIfNeededMiddleware,
    verifyPrAfterAgentMiddleware,
    cleanupSandboxMiddleware,
  ];

  // 9. Create and return agent
  const model = await makeModel(DEFAULT_LLM_MODEL_ID);
  const agent = createDeepAgent({
    model,
    // biome-ignore lint/suspicious/noExplicitAny: tool types vary across langchain versions
    tools: tools as any[],
    // biome-ignore lint/suspicious/noExplicitAny: middleware types vary by deepagents version
    middleware: middleware as any[],
    systemPrompt,
    backend: sandbox,
  });

  const langfuseHandler = await getLangfuseCallbackHandler();
  return langfuseHandler ? agent.withConfig({ callbacks: [langfuseHandler] }) : agent;
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
  const repoParentDir = repoDir.split("/").slice(0, -1).join("/") || "/";
  const mkdirResult = await sandbox.execute(`mkdir -p ${shellQuote(repoParentDir)} 2>&1`);
  if (mkdirResult.exitCode !== 0) {
    throw new Error(`Failed to prepare repository directory: ${mkdirResult.output}`);
  }
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
