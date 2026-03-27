/**
 * Environment variable configuration.
 * All env vars are read once at startup.
 */

export const config = {
  // Webhook secrets
  linearWebhookSecret: process.env["LINEAR_WEBHOOK_SECRET"] ?? "",
  githubWebhookSecret: process.env["GITHUB_WEBHOOK_SECRET"] ?? "",
  slackSigningSecret: process.env["SLACK_SIGNING_SECRET"] ?? "",

  // Slack
  slackBotToken: process.env["SLACK_BOT_TOKEN"] ?? "",
  slackBotUserId: process.env["SLACK_BOT_USER_ID"] ?? "",
  slackBotUsername: process.env["SLACK_BOT_USERNAME"] ?? "",

  // Default repo
  defaultRepoOwner: process.env["DEFAULT_REPO_OWNER"] ?? "langchain-ai",
  defaultRepoName: process.env["DEFAULT_REPO_NAME"] ?? "langchainplus",
  slackRepoOwner: process.env["SLACK_REPO_OWNER"] ?? process.env["DEFAULT_REPO_OWNER"] ?? "langchain-ai",
  slackRepoName: process.env["SLACK_REPO_NAME"] ?? process.env["DEFAULT_REPO_NAME"] ?? "langchainplus",

  // LangGraph
  langgraphUrl:
    process.env["LANGGRAPH_URL"] ?? process.env["LANGGRAPH_URL_PROD"] ?? "http://localhost:2024",

  // Agent version metadata
  agentVersionMetadata: process.env["LANGCHAIN_REVISION_ID"]
    ? { AGENT_VERSION: process.env["LANGCHAIN_REVISION_ID"] }
    : ({} as Record<string, string>),

  // Allowed GitHub orgs (empty = all allowed)
  allowedGithubOrgs: new Set(
    (process.env["ALLOWED_GITHUB_ORGS"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),

  // Linear
  linearApiKey: process.env["LINEAR_API_KEY"] ?? "",

  // GitHub App
  githubAppId: process.env["GITHUB_APP_ID"] ?? "",
  githubAppPrivateKey: process.env["GITHUB_APP_PRIVATE_KEY"] ?? "",
  githubAppInstallationId: process.env["GITHUB_APP_INSTALLATION_ID"] ?? "",

  // Encryption
  tokenEncryptionKey: process.env["TOKEN_ENCRYPTION_KEY"] ?? "",

  // Tracing
  langfuseBaseUrl:
    process.env["LANGFUSE_BASE_URL"] ?? process.env["LANGFUSE_HOST"] ?? "http://localhost:3000",
  langfuseProjectId: process.env["LANGFUSE_PROJECT_ID"] ?? "",

  // Server
  port: parseInt(process.env["PORT"] ?? "8000", 10),
} as const;

export type RepoConfig = { owner: string; name: string };

export const GITHUB_BOT_MESSAGE_PREFIXES = [
  "🔐 **GitHub Authentication Required**",
  "✅ **Pull Request Created**",
  "✅ **Pull Request Updated**",
  "**Pull Request Created**",
  "**Pull Request Updated**",
  "🤖 **Agent Response**",
  "❌ **Agent Error**",
] as const;

export function isRepoOrgAllowed(repoConfig: RepoConfig): boolean {
  if (config.allowedGithubOrgs.size === 0) return true;
  return config.allowedGithubOrgs.has(repoConfig.owner.toLowerCase());
}
