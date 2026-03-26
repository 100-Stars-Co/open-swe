"""GitHub App authentication utilities.

This module handles GitHub token resolution using GitHub App installation
tokens only. Per-user OAuth via LangSmith has been removed.
"""

from __future__ import annotations

import logging

from langgraph.graph.state import RunnableConfig
from langgraph_sdk import get_client

from ..encryption import encrypt_token
from .github_app import get_github_app_installation_token
from .github_token import get_github_token_from_thread

logger = logging.getLogger(__name__)

client = get_client()


def is_bot_token_only_mode() -> bool:
    """Check if we're in bot-token-only mode.

    Always returns True since LangSmith user lookup/OAuth has been removed.
    All GitHub operations use the GitHub App installation token.
    """
    return True


async def persist_encrypted_github_token(thread_id: str, token: str) -> str:
    """Encrypt a GitHub token and store it on the thread metadata."""
    encrypted = encrypt_token(token)
    await client.threads.update(
        thread_id=thread_id,
        metadata={"github_token_encrypted": encrypted},
    )
    return encrypted


async def _resolve_bot_installation_token(thread_id: str) -> tuple[str, str]:
    """Get a GitHub App installation token and persist it for the thread."""
    bot_token = await get_github_app_installation_token()
    if not bot_token:
        raise RuntimeError(
            "GitHub App is not configured. "
            "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID."
        )
    logger.info("Using GitHub App installation token for thread %s", thread_id)
    encrypted = await persist_encrypted_github_token(thread_id, bot_token)
    return bot_token, encrypted


async def resolve_github_token(config: RunnableConfig, thread_id: str) -> tuple[str, str]:
    """Resolve a GitHub token from the run config.

    Always uses the GitHub App installation token since per-user OAuth
    via LangSmith has been removed.

    For GitHub-triggered runs, first checks for a cached token on the thread.

    Returns:
        (github_token, new_encrypted) tuple.

    Raises:
        RuntimeError: If token resolution fails.
    """
    configurable = config.get("configurable", {})
    source = configurable.get("source")

    # For GitHub-triggered runs, check for cached token first
    if source == "github":
        cached_token, cached_encrypted = await get_github_token_from_thread(thread_id)
        if cached_token and cached_encrypted:
            return cached_token, cached_encrypted

    # Always use GitHub App installation token
    return await _resolve_bot_installation_token(thread_id)
