import type { RunnableConfig } from "@langchain/core/runnables";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createDeepAgent } from "deepagents";
import { getLangfuseCallbackHandler } from "../integrations/langfuse.js";
import {
  cleanupSandboxMiddleware,
  ensureNoEmptyMsgMiddleware,
  openPrIfNeededMiddleware,
  toolErrorHandlerMiddleware,
  verifyPrAfterAgentMiddleware,
} from "../middleware/index.js";
import { constructSystemPrompt } from "../prompt.js";
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
} from "../tools/index.js";
import { readAgentsMd } from "../utils/agentsMd.js";
import { persistEncryptedGithubToken, resolveGithubToken } from "../utils/auth.js";
import {
  cleanupGitCredentials,
  gitCheckoutBranch,
  gitCurrentBranch,
  gitFetchOrigin,
  gitPullBranch,
  isValidGitRepo,
  removeDirectory,
  setupGitCredentials,
} from "../utils/github.js";
import { makeModel } from "../utils/model.js";
import { resolveSandboxRepoDir } from "../utils/repoDir.js";
import { getOrCreateSandbox } from "../utils/sandboxLifecycle.js";
import { setSandboxMetadata } from "../utils/sandboxState.js";

const DEFAULT_LLM_MODEL_ID = process.env.DEEPAGENTS_MODEL ?? "anthropic:claude-opus-4-6";

const registeredTools = [
  fetchUrl,
  httpRequest,
  webSearch,
  commitAndOpenPr,
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
  telegramReply,
  verifyPrTool,
];

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

type DeepAgentGraph = Awaited<ReturnType<typeof createDeepAgent>>;

let sharedCheckpointer: PostgresSaver | MemorySaver | null = null;

async function getCheckpointer(): Promise<PostgresSaver | MemorySaver> {
  if (!sharedCheckpointer) {
    sharedCheckpointer = process.env.DATABASE_URL
      ? PostgresSaver.fromConnString(process.env.DATABASE_URL)
      : new MemorySaver();
  }

  if ("setup" in sharedCheckpointer && typeof sharedCheckpointer.setup === "function") {
    await sharedCheckpointer.setup();
  }

  return sharedCheckpointer;
}

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

  if (baseBranch) {
    await gitCheckoutBranch(sandbox, repoDir, baseBranch);
  }
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

export async function buildAgent(config: RunnableConfig): Promise<DeepAgentGraph> {
  const configurable = (config.configurable ?? {}) as AgentConfigurable;
  const { thread_id: threadId, repo, base_branch: baseBranch } = configurable;

  if (!threadId || !repo?.owner || !repo?.name) {
    throw new Error("Agent runtime requires thread_id and repo configuration");
  }

  const [token, encryptedToken] = await resolveGithubToken({}, threadId);
  if (encryptedToken) {
    await persistEncryptedGithubToken(threadId, encryptedToken);
  }

  const sandbox = await getOrCreateSandbox(threadId);
  const repoDir = resolveSandboxRepoDir(repo.owner, repo.name);
  await cloneOrPullRepo(sandbox, repo, repoDir, token, baseBranch);
  await setSandboxMetadata(threadId, { repoDir, baseBranch: baseBranch ?? null });

  const agentsMdResult = await readAgentsMd(sandbox, repoDir);
  const systemPrompt = constructSystemPrompt({
    workingDir: repoDir,
    jiraProjectKey: configurable.jira_project_key,
    jiraIssueKey: configurable.jira_issue_key,
    agentsMd: agentsMdResult?.content,
    agentsMdFilename: agentsMdResult?.filename,
  });

  const tools = [...registeredTools];
  if (process.env.FIGMA_API_KEY) {
    // biome-ignore lint/suspicious/noExplicitAny: tool types vary
    (tools as any[]).push(figmaGetFile, figmaGetComponent, figmaExportImage);
  }

  const model = await makeModel(DEFAULT_LLM_MODEL_ID);
  return createDeepAgent({
    model,
    // biome-ignore lint/suspicious/noExplicitAny: tool types vary across langchain versions
    tools: tools as any[],
    // biome-ignore lint/suspicious/noExplicitAny: middleware types vary across deepagents versions
    middleware: [
      toolErrorHandlerMiddleware,
      ensureNoEmptyMsgMiddleware,
      openPrIfNeededMiddleware,
      verifyPrAfterAgentMiddleware,
      cleanupSandboxMiddleware,
    ] as any[],
    systemPrompt,
    backend: sandbox,
    checkpointer: await getCheckpointer(),
  });
}

export async function runAgent(configurable: AgentConfigurable, message: string): Promise<void> {
  const agent = await buildAgent({ configurable });
  const langfuseHandler = await getLangfuseCallbackHandler();
  const config = langfuseHandler
    ? { configurable, callbacks: [langfuseHandler] }
    : { configurable };

  await agent.invoke(
    {
      messages: [new HumanMessage(message)],
    },
    config,
  );
}
