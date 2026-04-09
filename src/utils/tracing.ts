/**
 * Tracing URL utilities for Langfuse.
 * Mirrors agent/utils/tracing.py
 */

/**
 * Build the Langfuse trace URL for a given run ID.
 *
 * For self-hosted Langfuse, the URL format is:
 * {LANGFUSE_HOST}/project/{LANGFUSE_PROJECT_ID}/traces/{run_id}
 */
export function getTraceUrl(runId: string): string | null {
  try {
    const hostUrl = (
      process.env.LANGFUSE_BASE_URL ??
      process.env.LANGFUSE_HOST ??
      "http://localhost:3000"
    ).replace(/\/+$/, "");

    const projectId = process.env.LANGFUSE_PROJECT_ID;
    if (!projectId) {
      console.warn(
        `LANGFUSE_PROJECT_ID not set, cannot generate trace URL for run ${runId}`,
      );
      return null;
    }

    return `${hostUrl}/project/${projectId}/traces/${runId}`;
  } catch {
    console.warn(`Failed to build Langfuse trace URL for run ${runId}`);
    return null;
  }
}
