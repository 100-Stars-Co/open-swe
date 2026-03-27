/**
 * Mapping of Linear team names to GitHub repository configurations.
 * Mirrors agent/utils/linear_team_repo_map.py
 */

export type RepoTarget = { owner: string; name: string };
export type TeamConfig =
  | RepoTarget
  | { projects?: Record<string, RepoTarget>; default?: RepoTarget };

export const LINEAR_TEAM_TO_REPO: Record<string, TeamConfig> = {
  "Brace's test workspace": { owner: "langchain-ai", name: "open-swe" },
  "Yogesh-dev": {
    projects: {
      "open-swe-v3-test": { owner: "aran-yogesh", name: "nimedge" },
      "open-swe-dev-test": { owner: "aran-yogesh", name: "TalkBack" },
    },
    default: { owner: "aran-yogesh", name: "TalkBack" },
  },
  "LangChain OSS": {
    projects: {
      deepagents: { owner: "langchain-ai", name: "deepagents" },
      langchain: { owner: "langchain-ai", name: "langchain" },
    },
  },
  "Applied AI": {
    projects: {
      "GTM Engineering": { owner: "langchain-ai", name: "ai-sdr" },
    },
    default: { owner: "langchain-ai", name: "ai-sdr" },
  },
  Docs: { default: { owner: "langchain-ai", name: "docs" } },
  "Open SWE": { default: { owner: "langchain-ai", name: "open-swe" } },
  "LangSmith Deployment": { default: { owner: "langchain-ai", name: "langgraph-api" } },
};

/**
 * Look up repository configuration from the LINEAR_TEAM_TO_REPO mapping.
 * Falls back to defaultOwner/defaultName if no mapping is found.
 */
export function getRepoConfigFromTeamMapping(
  teamIdentifier: string,
  projectName = "",
  defaultOwner = "langchain-ai",
  defaultName = "langchainplus",
): RepoTarget {
  const fallback: RepoTarget = { owner: defaultOwner, name: defaultName };
  if (!teamIdentifier || !(teamIdentifier in LINEAR_TEAM_TO_REPO)) return fallback;

  const teamConfig = LINEAR_TEAM_TO_REPO[teamIdentifier] as TeamConfig;

  // Direct repo target
  if ("owner" in teamConfig && "name" in teamConfig) {
    return teamConfig as RepoTarget;
  }

  const complex = teamConfig as { projects?: Record<string, RepoTarget>; default?: RepoTarget };

  // Project-specific mapping
  if (complex.projects && projectName && projectName in complex.projects) {
    return complex.projects[projectName] as RepoTarget;
  }

  // Default within team
  if (complex.default) return complex.default;

  return fallback;
}
