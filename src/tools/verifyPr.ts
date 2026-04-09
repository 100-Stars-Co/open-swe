/**
 * PR verification tool — runs repo-aware checks in an isolated sandbox.
 * Mirrors agent/tools/verify_pr.py
 *
 * Three-phase workflow:
 *   1. Scan repo structure (Makefile, package.json, etc.)
 *   2. Plan verification commands (model-based or heuristic)
 *   3. Execute setup + verification commands in sandbox
 *
 * Results are posted as a GitHub comment with labels.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createOpenSandbox } from "../integrations/opensandbox.js";
import { getInstallationToken } from "../utils/githubApp.js";
import { postGithubCommentOnIssue } from "../utils/githubComments.js";

const DEFAULT_VERIFICATION_TIMEOUT = Number.parseInt(
  process.env.PR_VERIFY_TIMEOUT ?? "600",
  10,
);
const DEFAULT_VERIFY_MODEL =
  process.env.PR_VERIFY_MODEL ??
  process.env.DEEPAGENTS_MODEL ??
  "anthropic:claude-opus-4-6";
const MAX_COMMANDS_PER_PHASE = 4;
const MAX_FILE_READ_BYTES = 20_000;
const UNSAFE_TOKEN_RE = /[;&|`$()<>]/;

const PACKAGE_MANAGER_TO_INSTALL: Record<string, string[]> = {
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  npm: ["npm", "ci"],
  yarn: ["yarn", "install", "--frozen-lockfile"],
  bun: ["bun", "install", "--frozen-lockfile"],
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface VerificationResult {
  success: boolean;
  status: "passed" | "failed" | "blocked";
  pr_number: number;
  results: CommandResult[];
  comment_posted: boolean;
  labels_added: string[];
  error: string | null;
  planned_commands: { setup: string[][]; verify: string[][] };
  planner?: string;
  repo_type?: string;
}

interface CommandResult {
  phase: string;
  command: string;
  exit_code: number;
  output: string;
  truncated: boolean;
}

interface RepoScan {
  files: Record<string, boolean>;
  package_manager: string | null;
  package_json: {
    name?: string;
    packageManager?: string;
    scripts: Record<string, string>;
  };
  workflows: Array<{ path: string; content: string }>;
}

interface VerificationPlan {
  repo_type: string;
  setup_commands: string[][];
  verification_commands: string[][];
  reasoning: string;
  planner: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shellJoin(cmd: string[]): string {
  return cmd.map((part) => shellQuote(part)).join(" ");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// biome-ignore lint/suspicious/noExplicitAny: sandbox type varies
function safeReadFile(sandbox: any, repoDir: string, relPath: string): string {
  const result = sandbox.execute(
    `cd ${shellQuote(repoDir)} && if [ -f ${shellQuote(relPath)} ]; then head -c ${MAX_FILE_READ_BYTES} ${shellQuote(relPath)}; fi`,
  );
  return result.exitCode === 0 && result.output ? result.output : "";
}

// biome-ignore lint/suspicious/noExplicitAny: sandbox type varies
function fileExists(sandbox: any, repoDir: string, relPath: string): boolean {
  const result = sandbox.execute(
    `cd ${shellQuote(repoDir)} && test -f ${shellQuote(relPath)}`,
  );
  return result.exitCode === 0;
}

// biome-ignore lint/suspicious/noExplicitAny: sandbox type varies
function listWorkflows(sandbox: any, repoDir: string): string[] {
  const result = sandbox.execute(
    `cd ${shellQuote(repoDir)} && if [ -d .github/workflows ]; then find .github/workflows -maxdepth 1 -type f | sort; fi`,
  );
  if (result.exitCode !== 0 || !result.output) return [];
  return result.output
    .split("\n")
    .map((l: string) => l.trim())
    .filter(Boolean);
}

function detectPackageManager(files: Record<string, boolean>): string | null {
  if (files["pnpm-lock.yaml"]) return "pnpm";
  if (files["package-lock.json"]) return "npm";
  if (files["yarn.lock"]) return "yarn";
  if (files["bun.lockb"] || files["bun.lock"]) return "bun";
  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: sandbox type varies
function scanRepo(sandbox: any, repoDir: string): RepoScan {
  const trackedFiles = [
    "Makefile",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
  ];

  const files: Record<string, boolean> = {};
  for (const name of trackedFiles) {
    files[name] = fileExists(sandbox, repoDir, name);
  }

  const packageJsonRaw = files["package.json"]
    ? safeReadFile(sandbox, repoDir, "package.json")
    : "";

  const workflows: Array<{ path: string; content: string }> = [];
  for (const wfPath of listWorkflows(sandbox, repoDir).slice(0, 5)) {
    workflows.push({
      path: wfPath,
      content: safeReadFile(sandbox, repoDir, wfPath),
    });
  }

  let packageJson: Record<string, unknown> = {};
  if (packageJsonRaw) {
    try {
      packageJson = JSON.parse(packageJsonRaw);
    } catch {
      console.warn("Unable to parse package.json during verification scan");
    }
  }

  return {
    files,
    package_manager: detectPackageManager(files),
    package_json: {
      name: packageJson.name as string | undefined,
      packageManager: packageJson.packageManager as string | undefined,
      scripts: (packageJson.scripts as Record<string, string>) ?? {},
    },
    workflows,
  };
}

function normalizeCommandList(commands: unknown): string[][] {
  if (!Array.isArray(commands)) return [];
  const normalized: string[][] = [];
  for (const cmd of commands.slice(0, MAX_COMMANDS_PER_PHASE)) {
    if (
      Array.isArray(cmd) &&
      cmd.every((part: unknown) => typeof part === "string" && part)
    ) {
      normalized.push(cmd);
    }
  }
  return normalized;
}

function commandsAreSafe(commands: string[][]): boolean {
  for (const cmd of commands) {
    for (const token of cmd) {
      if (UNSAFE_TOKEN_RE.test(token)) return false;
    }
  }
  return true;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed;
  } catch {
    // try regex extraction
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed;
  } catch {
    // give up
  }
  return null;
}

function buildHeuristicPlan(scan: RepoScan): VerificationPlan {
  const { files } = scan;

  if (files.Makefile) {
    return {
      repo_type: "make",
      setup_commands: [],
      verification_commands: [
        ["make", "test"],
        ["make", "lint"],
      ],
      reasoning: "Repo has a Makefile, so use make-based verification targets.",
      planner: "heuristic",
    };
  }

  const scripts = scan.package_json.scripts;
  const pm = scan.package_manager;
  if (Object.keys(scripts).length && pm) {
    const verificationCommands: string[][] = [];
    for (const scriptName of ["test", "lint", "typecheck", "build"]) {
      if (scriptName in scripts) {
        verificationCommands.push([pm, scriptName]);
      }
    }
    if (verificationCommands.length) {
      const setupCommand = PACKAGE_MANAGER_TO_INSTALL[pm];
      return {
        repo_type: "javascript",
        setup_commands: setupCommand ? [setupCommand] : [],
        verification_commands: verificationCommands.slice(
          0,
          MAX_COMMANDS_PER_PHASE,
        ),
        reasoning:
          "Repo has package.json scripts and a detected package manager.",
        planner: "heuristic",
      };
    }
  }

  return {
    repo_type: "unknown",
    setup_commands: [],
    verification_commands: [],
    reasoning: "Could not detect safe repo-native verification commands.",
    planner: "heuristic",
  };
}

// @ts-ignore: kept for future model-based planning
// biome-ignore lint/correctness/noUnusedVariables: kept for future model-based planning
async function planCommandsWithModel(
  scan: RepoScan,
): Promise<VerificationPlan | null> {
  if (
    !scan.files.Makefile &&
    !scan.files["package.json"] &&
    !scan.files["pyproject.toml"] &&
    !scan.files["go.mod"]
  ) {
    return null;
  }

  const scripts = Object.keys(scan.package_json.scripts).sort();
  const prompt = `You are planning CI verification commands for a checked-out repository.\nReturn JSON only with keys: repo_type, setup_commands, verification_commands, reasoning.\nEach command must be an array of argv strings.\nRules:\n- Use repo-native commands only.\n- Prefer Makefile targets if the repo is make-based.\n- For JS/TS repos, prefer the detected package manager and only scripts that exist.\n- Do not invent commands not supported by the repo.\n- If no safe plan exists, return empty command arrays and explain why.\nRepository scan:\n${JSON.stringify(scan, null, 2)}\nKnown scripts: ${JSON.stringify(scripts)}`;

  try {
    const { makeModel } = await import("../utils/model.js");
    const model = await makeModel(DEFAULT_VERIFY_MODEL, {
      temperature: 0,
      maxTokens: 1500,
    });
    const resolvedModel =
      typeof model === "string"
        ? await (
            await import("langchain")
          ).initChatModel(model, { temperature: 0, maxTokens: 1500 })
        : model;
    const response = await resolvedModel.invoke(prompt);
    let content = response.content;
    if (Array.isArray(content)) {
      content = content
        .map((part: unknown) =>
          typeof part === "object" && part !== null && "text" in part
            ? (part as { text: string }).text
            : String(part),
        )
        .join("");
    }
    if (typeof content !== "string") content = String(content);

    const plan = extractJsonObject(content as string);
    if (plan) {
      return { ...plan, planner: "model" } as unknown as VerificationPlan;
    }
  } catch (err) {
    console.error("Model-based verification planning failed:", err);
  }
  return null;
}

function resolveVerificationPlan(
  scan: RepoScan,
  explicitCommands?: string[][] | null,
): VerificationPlan {
  if (explicitCommands?.length) {
    return {
      repo_type: "explicit",
      setup_commands: [],
      verification_commands: explicitCommands,
      reasoning: "Using explicit verification commands.",
      planner: "explicit",
    };
  }

  const envCommands = process.env.PR_VERIFY_COMMANDS;
  if (envCommands) {
    try {
      const parsed = JSON.parse(envCommands);
      const commands = normalizeCommandList(parsed);
      if (commands.length) {
        return {
          repo_type: "env",
          setup_commands: [],
          verification_commands: commands,
          reasoning: "Using PR_VERIFY_COMMANDS override.",
          planner: "env",
        };
      }
    } catch {
      console.warn("Invalid PR_VERIFY_COMMANDS JSON, ignoring override");
    }
  }

  // heuristic fallback (model planning is async but verify_pr is sync in Python;
  // we keep it simple here with heuristic only for now to match the sync pattern)
  return buildHeuristicPlan(scan);
}

function runCommand(
  // biome-ignore lint/suspicious/noExplicitAny: sandbox type varies
  sandbox: any,
  repoDir: string,
  cmd: string[],
  timeout: number,
  phase: string,
): CommandResult {
  const cmdStr = shellJoin(cmd);
  const result = sandbox.execute(`cd ${shellQuote(repoDir)} && ${cmdStr}`, {
    timeout,
  });
  const output = result.output ?? "";
  return {
    phase,
    command: cmdStr,
    exit_code: result.exitCode ?? 1,
    output: output.slice(0, 5000),
    truncated: output.length > 5000,
  };
}

function setupFallbackCommands(
  cmd: string[],
  result: CommandResult,
  scan: RepoScan,
): string[][] {
  if (
    cmd[0] === "npm" &&
    cmd[1] === "ci" &&
    scan.package_manager === "npm" &&
    result.exit_code !== 0 &&
    (result.output ?? "").includes("ERESOLVE")
  ) {
    return [
      ["npm", "install", "--legacy-peer-deps"],
      ["npm", "install"],
    ];
  }
  return [];
}

function buildComment(opts: {
  prNumber: number;
  headBranch: string;
  timeout: number;
  status: string;
  reason: string | null;
  results: CommandResult[];
  plannedCommands: { setup: string[][]; verify: string[][] };
}): string {
  const {
    prNumber,
    headBranch,
    timeout,
    status,
    reason,
    results,
    plannedCommands,
  } = opts;
  const emojiMap: Record<string, string> = {
    passed: "✅",
    failed: "❌",
    blocked: "⛔",
  };
  const textMap: Record<string, string> = {
    passed: "PASSED",
    failed: "FAILED",
    blocked: "BLOCKED",
  };
  const emoji = emojiMap[status] ?? "❌";
  const text = textMap[status] ?? "FAILED";

  const lines = [
    `## ${emoji} PR Verification ${text}`,
    "",
    `**PR:** #${prNumber}`,
    `**Branch:** \`${headBranch}\``,
    `**Verification Time:** ${timeout}s timeout`,
    "",
  ];

  if (reason) lines.push(`**Reason:** ${reason}`, "");
  if (plannedCommands.setup.length) {
    lines.push("### Planned Setup");
    for (const cmd of plannedCommands.setup)
      lines.push(`- \`${shellJoin(cmd)}\``);
    lines.push("");
  }
  if (plannedCommands.verify.length) {
    lines.push("### Planned Verification");
    for (const cmd of plannedCommands.verify)
      lines.push(`- \`${shellJoin(cmd)}\``);
    lines.push("");
  }

  lines.push("### Results:");
  if (!results.length) lines.push("- No commands were executed.");

  for (const item of results) {
    const prefix = item.exit_code === 0 ? "✅" : "❌";
    const phaseLabel = item.phase === "setup" ? "setup" : "verify";
    lines.push(`- ${prefix} **\`${item.command}\`** (${phaseLabel})`);
    if (item.output) {
      const preview = item.output.slice(0, 500);
      lines.push("  ```", `  ${preview}`, "  ```");
    }
  }

  lines.push("", "_Verified by Open SWE_");
  return lines.join("\n");
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

async function fetchPrDetails(
  owner: string,
  name: string,
  prNumber: number,
  token: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (response.ok) return (await response.json()) as Record<string, unknown>;
    console.error(`Failed to fetch PR #${prNumber}: ${response.status}`);
  } catch (err) {
    console.error(`Error fetching PR #${prNumber}:`, err);
  }
  return null;
}

async function addPrLabel(
  owner: string,
  name: string,
  prNumber: number,
  label: string,
  token: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/labels`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ labels: [label] }),
      },
    );
    return response.status === 200 || response.status === 201;
  } catch (err) {
    console.error(`Failed to add label ${label} to PR #${prNumber}:`, err);
    return false;
  }
}

async function removePrLabel(
  owner: string,
  name: string,
  prNumber: number,
  label: string,
  token: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/labels/${label}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    return response.status === 200 || response.status === 204;
  } catch (err) {
    console.error(`Failed to remove label ${label} from PR #${prNumber}:`, err);
    return false;
  }
}

// ─── Main verify function ─────────────────────────────────────────────────────

export async function verifyPr(
  prNumber: number,
  options?: {
    commands?: string[][] | null;
    timeout?: number;
    addLabels?: boolean;
    repoConfig?: { owner: string; name: string };
  },
): Promise<VerificationResult> {
  const timeout = options?.timeout ?? DEFAULT_VERIFICATION_TIMEOUT;
  const addLabels = options?.addLabels ?? true;
  const blocked = (error: string): VerificationResult => ({
    success: false,
    status: "blocked",
    pr_number: prNumber,
    results: [],
    comment_posted: false,
    labels_added: [],
    error,
    planned_commands: { setup: [], verify: [] },
  });

  try {
    const repoConfig = options?.repoConfig;
    if (!repoConfig?.owner || !repoConfig?.name) {
      return blocked("Missing repo owner/name in config");
    }

    const { owner, name } = repoConfig;
    const token = await getInstallationToken();
    if (!token) return blocked("Failed to get GitHub App installation token");

    const prDetails = await fetchPrDetails(owner, name, prNumber, token);
    if (!prDetails) return blocked(`Could not fetch PR #${prNumber} details`);

    const headBranch = (prDetails.head as Record<string, unknown>)
      ?.ref as string;
    const headRepoUrl = (
      (prDetails.head as Record<string, unknown>)?.repo as Record<
        string,
        unknown
      >
    )?.clone_url as string;

    if (!headBranch || !headRepoUrl) {
      return blocked("Could not determine PR branch or repository");
    }

    const sandbox = await createOpenSandbox(undefined, timeout);

    try {
      const credFile = "/tmp/.git-credentials";
      await sandbox.write(credFile, `https://git:${token}@github.com\n`);
      await sandbox.execute(`chmod 600 ${credFile}`);

      const workDir = "/home/user";
      const repoDir = `${workDir}/${name}`;

      const cloneResult = await sandbox.execute(
        `git -c credential.helper='store --file=${credFile}' clone ${shellQuote(headRepoUrl)} ${shellQuote(repoDir)}`,
      );
      if (cloneResult.exitCode !== 0) {
        return blocked(`Failed to clone repository: ${cloneResult.output}`);
      }

      const checkoutResult = await sandbox.execute(
        `cd ${shellQuote(repoDir)} && git config credential.helper 'store --file=${credFile}' && git fetch origin && git checkout ${shellQuote(headBranch)}`,
      );
      if (checkoutResult.exitCode !== 0) {
        return blocked(
          `Failed to checkout branch ${headBranch}: ${checkoutResult.output}`,
        );
      }

      const scan = scanRepo(sandbox, repoDir);
      const plan = resolveVerificationPlan(scan, options?.commands);
      const setupCommands = normalizeCommandList(plan.setup_commands);
      const verificationCommands = normalizeCommandList(
        plan.verification_commands,
      );
      const plannedCommands = {
        setup: setupCommands,
        verify: verificationCommands,
      };
      const results: CommandResult[] = [];
      let status: "passed" | "failed" | "blocked" = "passed";
      let error: string | null = null;

      if (!verificationCommands.length) {
        status = "blocked";
        error = plan.reasoning || "No safe verification commands were found";
      } else if (
        !commandsAreSafe([...setupCommands, ...verificationCommands])
      ) {
        status = "blocked";
        error = "Verification planner returned unsafe commands";
      } else {
        // Run setup
        for (const cmd of setupCommands) {
          const result = runCommand(sandbox, repoDir, cmd, timeout, "setup");
          results.push(result);
          if (result.exit_code !== 0) {
            let fallbackSucceeded = false;
            for (const fallbackCmd of setupFallbackCommands(
              cmd,
              result,
              scan,
            )) {
              const fbResult = runCommand(
                sandbox,
                repoDir,
                fallbackCmd,
                timeout,
                "setup",
              );
              results.push(fbResult);
              if (fbResult.exit_code === 0) {
                fallbackSucceeded = true;
                break;
              }
            }
            if (!fallbackSucceeded) {
              status = "failed";
              error = `Setup failed: ${shellJoin(cmd)}`;
              break;
            }
          }
        }

        // Run verification
        if (status === "passed") {
          for (const cmd of verificationCommands) {
            const result = runCommand(sandbox, repoDir, cmd, timeout, "verify");
            results.push(result);
            if (result.exit_code !== 0) {
              status = "failed";
              error = `Verification failed: ${shellJoin(cmd)}`;
              break;
            }
          }
        }
      }

      const commentBody = buildComment({
        prNumber,
        headBranch,
        timeout,
        status,
        reason: error ?? plan.reasoning,
        results,
        plannedCommands,
      });

      const commentPosted = await postGithubCommentOnIssue(
        { owner, name },
        prNumber,
        commentBody,
        token,
      );

      const labelsAdded: string[] = [];
      if (addLabels) {
        if (status === "passed") {
          await removePrLabel(
            owner,
            name,
            prNumber,
            "verification-failed",
            token,
          );
          if (await addPrLabel(owner, name, prNumber, "verified", token)) {
            labelsAdded.push("verified");
          }
        } else {
          await removePrLabel(owner, name, prNumber, "verified", token);
          if (
            await addPrLabel(
              owner,
              name,
              prNumber,
              "verification-failed",
              token,
            )
          ) {
            labelsAdded.push("verification-failed");
          }
        }
      }

      return {
        success: status === "passed",
        status,
        pr_number: prNumber,
        results,
        comment_posted: commentPosted,
        labels_added: labelsAdded,
        error,
        planned_commands: plannedCommands,
        planner: plan.planner,
        repo_type: plan.repo_type,
      };
    } finally {
      try {
        await sandbox.execute("rm -f /tmp/.git-credentials");
      } catch {
        // ignore
      }
    }
  } catch (e) {
    console.error("verify_pr failed:", e);
    return blocked(
      `${e instanceof Error ? e.constructor.name : "Error"}: ${e}`,
    );
  }
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const schema = z.object({
  pr_number: z.number().int().describe("The pull request number to verify."),
  timeout: z
    .number()
    .int()
    .optional()
    .describe("Timeout in seconds for the verification run."),
  add_labels: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to add 'verified' / 'verification-failed' labels."),
});

export const verifyPrTool = tool(
  async ({ pr_number, timeout, add_labels }, config: RunnableConfig) => {
    const configurable = config?.configurable ?? {};
    const repo = configurable.repo as
      | { owner: string; name: string }
      | undefined;

    const result = await verifyPr(pr_number, {
      timeout: timeout ?? DEFAULT_VERIFICATION_TIMEOUT,
      addLabels: add_labels,
      repoConfig: repo ?? undefined,
    });

    return JSON.stringify(result);
  },
  {
    name: "verify_pr",
    description:
      "Verify a Pull Request by running repo-aware checks (build, test, lint) " +
      "in an isolated sandbox. Posts results as a GitHub comment and optionally adds labels.",
    schema,
  },
);
