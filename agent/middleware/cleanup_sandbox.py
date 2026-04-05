"""After-agent middleware that cleans up Daytona sandboxes after task completion.

Runs once after the agent finishes. Only deletes Daytona sandboxes;
other providers (LangSmith, Modal, etc.) remain persistent by design.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from langchain.agents.middleware import AgentState, after_agent
from langgraph_sdk import get_client
from langgraph.config import get_config
from langgraph.runtime import Runtime

from ..integrations.daytona import delete_daytona_sandbox
from ..utils.sandbox_state import SANDBOX_BACKENDS, get_sandbox_id_from_metadata

logger = logging.getLogger(__name__)

# Only auto-delete Daytona sandboxes after task completion
SANDBOX_TYPE = os.getenv("SANDBOX_TYPE", "langsmith")


@after_agent
async def cleanup_sandbox_after_task(
    state: AgentState,
    runtime: Runtime,
) -> dict[str, Any] | None:
    """Middleware that deletes Daytona sandboxes after task completion.

    Only runs for Daytona sandboxes to avoid resource leaks.
    Other sandbox providers remain persistent for reuse.
    """
    if SANDBOX_TYPE != "daytona":
        return None

    try:
        config = get_config()
        configurable = config.get("configurable", {})
        thread_id = configurable.get("thread_id")

        if not thread_id:
            logger.debug("No thread_id found, skipping sandbox cleanup")
            return None

        # Get sandbox_id from metadata
        sandbox_id = await get_sandbox_id_from_metadata(thread_id)
        if not sandbox_id:
            logger.debug(
                "No sandbox_id found for thread %s, skipping cleanup", thread_id
            )
            return None

        # Get the sandbox backend from cache
        sandbox_backend = SANDBOX_BACKENDS.get(thread_id)
        if sandbox_backend:
            # Get the actual sandbox ID from the backend
            actual_sandbox_id = getattr(sandbox_backend, "id", sandbox_id)

            # Delete the Daytona sandbox
            deleted = await asyncio.to_thread(delete_daytona_sandbox, actual_sandbox_id)

            if deleted:
                logger.info(
                    "Cleaned up Daytona sandbox %s for thread %s",
                    actual_sandbox_id,
                    thread_id,
                )
            else:
                logger.warning(
                    "Failed to clean up Daytona sandbox %s for thread %s",
                    actual_sandbox_id,
                    thread_id,
                )

            # Remove from cache regardless of deletion success
            SANDBOX_BACKENDS.pop(thread_id, None)

            # Clear sandbox_id from thread metadata
            try:
                client = get_client()
                await client.threads.update(
                    thread_id=thread_id,
                    metadata={"sandbox_id": None},
                )
                logger.debug("Cleared sandbox_id from thread %s metadata", thread_id)
            except Exception:
                logger.exception(
                    "Failed to clear sandbox_id from thread %s metadata", thread_id
                )

    except Exception:
        logger.exception("Error in cleanup_sandbox_after_task middleware")

    return None
