/**
 * Tracing URL utilities.
 * Ports agent/utils/tracing.py to TypeScript.
 */

import { config } from "./config.ts";

/** Build the Langfuse trace URL for a given run ID, or null if not configured. */
export function getTraceUrl(runId: string): string | null {
  const projectId = config.langfuseProjectId;
  if (!projectId) return null;
  const host = config.langfuseBaseUrl.replace(/\/$/, "");
  return `${host}/project/${projectId}/traces/${runId}`;
}
