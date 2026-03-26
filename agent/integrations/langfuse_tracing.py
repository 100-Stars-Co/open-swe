"""Langfuse tracing integration for LangGraph.

This module provides callback handler setup for Langfuse tracing.
See: https://langfuse.com/guides/cookbook/integration_langgraph
See: https://langfuse.com/docs/integrations/langchain
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from langfuse.langchain import CallbackHandler


_langfuse_handler: CallbackHandler | None = None
_langfuse_client = None


def get_langfuse_callback_handler() -> CallbackHandler | None:
    """Get or create a Langfuse CallbackHandler for LangGraph tracing.

    This function creates a singleton CallbackHandler instance that can be
    passed to LangGraph agents for automatic tracing.

    Required environment variables:
        - LANGFUSE_PUBLIC_KEY: Public API key for Langfuse
        - LANGFUSE_SECRET_KEY: Secret API key for Langfuse

    Optional environment variables:
        - LANGFUSE_BASE_URL: Langfuse host URL (defaults to https://cloud.langfuse.com)

    Returns:
        CallbackHandler instance if credentials are configured, None otherwise.
    """
    global _langfuse_handler, _langfuse_client

    if _langfuse_handler is not None:
        return _langfuse_handler

    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    host = os.environ.get("LANGFUSE_BASE_URL") or os.environ.get(
        "LANGFUSE_HOST", "https://cloud.langfuse.com"
    )

    if not public_key or not secret_key:
        logger.debug(
            "Langfuse not configured: LANGFUSE_PUBLIC_KEY and/or LANGFUSE_SECRET_KEY not set"
        )
        return None

    try:
        from langfuse import Langfuse
        from langfuse.langchain import CallbackHandler

        # Initialize Langfuse client (singleton pattern in v3.x+)
        # This must be done before creating the CallbackHandler
        _langfuse_client = Langfuse(
            public_key=public_key,
            secret_key=secret_key,
            host=host,
        )

        # In v3.x+, CallbackHandler() takes no arguments
        # It automatically uses the singleton Langfuse client
        _langfuse_handler = CallbackHandler()
        logger.info("Langfuse callback handler initialized successfully")
        return _langfuse_handler
    except ImportError:
        logger.warning(
            "langfuse package not installed. Install with: uv pip install 'langfuse>=2.0.0'"
        )
        return None
    except Exception as e:
        logger.warning("Failed to initialize Langfuse callback handler: %s", e)
        return None


def get_langfuse_client():
    """Get the Langfuse client instance.

    Returns:
        Langfuse client instance if configured, None otherwise.
    """
    global _langfuse_client
    if _langfuse_client is None:
        get_langfuse_callback_handler()
    return _langfuse_client


def is_langfuse_configured() -> bool:
    """Check if Langfuse is properly configured.

    Returns:
        True if all required environment variables are set.
    """
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    return bool(public_key and secret_key)
