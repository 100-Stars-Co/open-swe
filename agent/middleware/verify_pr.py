"""After-agent middleware that automatically verifies PRs after creation."""

from __future__ import annotations

import asyncio
import json as _json
import logging
import os
from typing import Any

from langchain.agents.middleware import AgentState, after_agent
from langgraph.config import get_config
from langgraph.runtime import Runtime

from ..tools.verify_pr import verify_pr

logger = logging.getLogger(__name__)

# Environment variable to enable auto-verification
AUTO_VERIFY_ENV_VAR = "OPEN_SWE_AUTO_VERIFY_PR"
DEFAULT_VERIFY_TIMEOUT = int(os.environ.get("PR_VERIFY_TIMEOUT", "600"))


def _extract_pr_number_from_messages(messages: list) -> int | None:
    """Extract PR number from commit_and_open_pr tool result."""
    for msg in reversed(messages):
        if isinstance(msg, dict):
            content = msg.get("content", "")
            name = msg.get("name", "")
        else:
            content = getattr(msg, "content", "")
            name = getattr(msg, "name", "")

        if name == "commit_and_open_pr" and content:
            try:
                parsed = _json.loads(content) if isinstance(content, str) else content
                if isinstance(parsed, dict) and parsed.get("success"):
                    # Extract PR number from pr_url if available
                    pr_url = parsed.get("pr_url", "")
                    # URL format: https://github.com/owner/repo/pull/123
                    if "/pull/" in pr_url:
                        try:
                            return int(pr_url.split("/pull/")[-1].split("/")[0])
                        except ValueError:
                            pass
            except (ValueError, TypeError):
                pass
    return None


async def _verify_pr_after_agent_impl(
    state: AgentState,
    runtime: Runtime,
) -> dict[str, Any] | None:
    """Implementation of the after-agent middleware for PR verification.

    Only runs if:
    1. OPEN_SWE_AUTO_VERIFY_PR environment variable is set to "true"
    2. The agent successfully created a PR via commit_and_open_pr
    3. A PR number can be extracted from the tool result
    """
    # Check if auto-verification is enabled
    if os.environ.get(AUTO_VERIFY_ENV_VAR, "").lower() not in ("1", "true", "yes"):
        return None

    logger.info("Auto-verification middleware started")

    try:
        config = get_config()
        configurable = config.get("configurable", {})
        thread_id = configurable.get("thread_id")

        if not thread_id:
            logger.debug("No thread_id found, skipping auto-verification")
            return None

        messages = state.get("messages", [])
        pr_number = _extract_pr_number_from_messages(messages)

        if not pr_number:
            logger.info("No PR creation detected, skipping auto-verification")
            return None

        logger.info("Auto-verifying PR #%s for thread %s", pr_number, thread_id)

        # Run verification
        result = await asyncio.to_thread(
            verify_pr,
            pr_number=pr_number,
            timeout=DEFAULT_VERIFY_TIMEOUT,
            add_labels=True,
        )

        if result.get("success"):
            logger.info("Auto-verification passed for PR #%s", pr_number)
        else:
            error = result.get("error")
            if error:
                logger.error("Auto-verification failed for PR #%s: %s", pr_number, error)
            else:
                logger.info("Auto-verification found issues in PR #%s", pr_number)

        return {"auto_verification": result}

    except Exception:
        logger.exception("Error in verify_pr_after_agent middleware")

    return None


# Create the decorated middleware function
verify_pr_after_agent = after_agent(_verify_pr_after_agent_impl)
