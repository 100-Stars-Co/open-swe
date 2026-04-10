/**
 * After-agent middleware that automatically verifies PRs after creation.
 * Mirrors agent/middleware/verify_pr.py
 *
 * Only runs when OPEN_SWE_AUTO_VERIFY_PR is enabled ("true" / "1" / "yes").
 * Scans recent messages for a successful commit_and_open_pr result, extracts
 * the PR number, and invokes verifyPr() in an isolated sandbox.
 */

import type { AIMessage, ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { verifyPr } from "../tools/verifyPr.js";

const AUTO_VERIFY_ENV_VAR = "OPEN_SWE_AUTO_VERIFY_PR";
const DEFAULT_VERIFY_TIMEOUT = Number.parseInt(process.env.PR_VERIFY_TIMEOUT ?? "600", 10);

function extractPrNumberFromMessages(messages: (AIMessage | ToolMessage)[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const name = "name" in msg ? (msg as ToolMessage).name : undefined;
    if (name !== "commit_and_open_pr") continue;

    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (!parsed.success) continue;

      const prUrl = parsed.pr_url as string | undefined;
      if (prUrl?.includes("/pull/")) {
        const num = Number.parseInt(prUrl.split("/pull/").pop()?.split("/")[0] ?? "", 10);
        if (!Number.isNaN(num)) return num;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export const verifyPrAfterAgentMiddleware = createMiddleware({
  name: "VerifyPrAfterAgent",
  afterAgent: async (state) => {
    const enabled = (process.env[AUTO_VERIFY_ENV_VAR] ?? "").toLowerCase();
    if (!["1", "true", "yes"].includes(enabled)) return {};

    const configurable = (state as Record<string, unknown>).configurable as
      | Record<string, unknown>
      | undefined;
    const repo = configurable?.repo as { owner: string; name: string } | undefined;

    if (!repo) return {};

    const messages =
      ((state as Record<string, unknown>).messages as (AIMessage | ToolMessage)[]) ?? [];

    const prNumber = extractPrNumberFromMessages(messages);
    if (!prNumber) return {};

    console.log(`[VerifyPrAfterAgent] Auto-verifying PR #${prNumber}`);

    try {
      const result = await verifyPr(prNumber, {
        timeout: DEFAULT_VERIFY_TIMEOUT,
        addLabels: true,
        repoConfig: repo,
      });

      if (result.success) {
        console.log(`[VerifyPrAfterAgent] PR #${prNumber} verification passed`);
      } else {
        console.log(
          `[VerifyPrAfterAgent] PR #${prNumber} verification ${result.status}: ${result.error}`,
        );
      }

      return {};
    } catch (err) {
      console.error("[VerifyPrAfterAgent] Error:", err);
      return {};
    }
  },
});
