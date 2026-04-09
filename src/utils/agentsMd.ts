/**
 * Read AGENTS.md or CLAUDE.md from a cloned repo inside the sandbox.
 * CLAUDE.md takes precedence over AGENTS.md (same as Python version).
 * Mirrors agent/utils/agents_md.py
 */

import type { SandboxBackendProtocol } from "deepagents";

const CANDIDATES = ["CLAUDE.md", "AGENTS.md"] as const;

export interface AgentsMdResult {
  content: string;
  filename: string;
}

/**
 * Attempt to read CLAUDE.md first, then AGENTS.md from the repo root.
 * Returns null if neither file exists in the sandbox.
 */
export async function readAgentsMd(
  sandbox: SandboxBackendProtocol,
  repoDir: string,
): Promise<AgentsMdResult | null> {
  for (const filename of CANDIDATES) {
    try {
      const path = `${repoDir}/${filename}`;
      const result = await sandbox.execute(
        `test -f ${shellQuote(path)} && cat ${shellQuote(path)}`,
      );
      if (result.exitCode === 0 && result.output.trim().length > 0) {
        return { content: result.output.trim(), filename };
      }
    } catch {
      // File doesn't exist or can't be read — try next
    }
  }
  return null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
