"""Tracing URL utilities for Langfuse."""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


def get_trace_url(run_id: str) -> str | None:
    """Build the Langfuse trace URL for a given run ID.

    For self-hosted Langfuse, the URL format is:
    {LANGFUSE_HOST}/project/{LANGFUSE_PROJECT_ID}/traces/{run_id}

    Args:
        run_id: The trace/run ID to generate a URL for.

    Returns:
        The full trace URL, or None if required environment variables are not set.
    """
    try:
        # Check LANGFUSE_BASE_URL first (used by langfuse package), then LANGFUSE_HOST
        host_url = os.environ.get("LANGFUSE_BASE_URL") or os.environ.get(
            "LANGFUSE_HOST", "http://localhost:3000"
        )
        project_id = os.environ.get("LANGFUSE_PROJECT_ID")

        if not project_id:
            logger.warning(
                "LANGFUSE_PROJECT_ID not set, cannot generate trace URL for run %s",
                run_id,
            )
            return None

        # Remove trailing slash from host_url if present
        host_url = host_url.rstrip("/")

        return f"{host_url}/project/{project_id}/traces/{run_id}"
    except Exception:
        logger.warning("Failed to build Langfuse trace URL for run %s", run_id, exc_info=True)
        return None
