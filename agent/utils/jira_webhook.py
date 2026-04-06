"""Jira webhook utilities for processing automation webhooks."""

from __future__ import annotations

import hashlib
import logging
from typing import Any

logger = logging.getLogger(__name__)


def verify_jira_webhook_secret(payload: bytes, secret: str, provided_secret: str) -> bool:
    """Verify the Jira webhook secret.

        Jira Automation sends the secret in a custom header. We compare it
    to the configured secret.

        Args:
            payload: Raw request body (for logging purposes only)
            secret: The expected webhook secret from environment
            provided_secret: The secret from the X-Jira-Webhook-Secret header

        Returns:
            True if the secret matches, False otherwise
    """
    if not secret:
        logger.warning(
            "JIRA_WEBHOOK_SECRET is not configured — accepting webhook without verification"
        )
        return True

    if not provided_secret:
        logger.warning("X-Jira-Webhook-Secret header is missing")
        return False

    return provided_secret == secret


def generate_thread_id_from_jira_issue(issue_key: str) -> str:
    """Generate a deterministic thread ID from a Jira issue key.

    Args:
        issue_key: The Jira issue key (e.g., "PROJ-123")

    Returns:
        A UUID-formatted thread ID derived from the issue key
    """
    hash_bytes = hashlib.sha256(f"jira-issue:{issue_key}".encode()).hexdigest()
    return (
        f"{hash_bytes[:8]}-{hash_bytes[8:12]}-{hash_bytes[12:16]}-"
        f"{hash_bytes[16:20]}-{hash_bytes[20:32]}"
    )


def parse_jira_webhook_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Parse and validate the Jira webhook payload.

    Args:
        payload: The JSON payload from the webhook

    Returns:
        Parsed data with issue details, or None if invalid
    """
    if not isinstance(payload, dict):
        logger.warning("Webhook payload is not a dictionary")
        return None

    issue_key = payload.get("issue_key")
    if not issue_key:
        logger.warning("Webhook payload missing 'issue_key'")
        return None

    return {
        "issue_key": issue_key,
        "issue_summary": payload.get("issue_summary", ""),
        "comment_body": payload.get("comment_body", ""),
        "comment_author": payload.get("comment_author", ""),
        "comment_author_email": payload.get("comment_author_email", ""),
        "project_key": payload.get("project_key", ""),
        "issue_url": payload.get("issue_url", ""),
        "issue_description": payload.get("issue_description", ""),
        "trigger": payload.get("trigger", ""),
    }


OPEN_SWE_TAGS = ("@openswe", "@open-swe")


def contains_bot_mention(text: str) -> bool:
    """Check if the text contains a mention of the Open SWE bot.

    Args:
        text: The text to check

    Returns:
        True if the text contains @openswe or @open-swe
    """
    text_lower = text.lower()
    return any(tag in text_lower for tag in OPEN_SWE_TAGS)


def extract_repo_from_text(text: str) -> dict[str, str] | None:
    """Extract repository owner/name from text.

    Looks for patterns like:
    - owner/repo
    - https://github.com/owner/repo

    Args:
        text: The text to search

    Returns:
        Dict with 'owner' and 'name' keys, or None if not found
    """
    import re

    # Pattern for GitHub URLs
    url_pattern = r"github\.com/(?P<owner>[\w\-\.]+)/(?P<name>[\w\-\.]+)"
    url_match = re.search(url_pattern, text)
    if url_match:
        return {
            "owner": url_match.group("owner"),
            "name": url_match.group("name"),
        }

    # Pattern for owner/repo (not in URL)
    # Look for "owner/repo" where owner and repo don't contain spaces or special chars
    simple_pattern = r"(?<!/)(?<![\w\-])(?P<owner>[\w\-\.]+)/(?P<name>[\w\-\.]+)(?![\w\-/])"
    simple_match = re.search(simple_pattern, text)
    if simple_match:
        owner = simple_match.group("owner")
        name = simple_match.group("name")
        # Filter out common false positives
        if owner.lower() not in ("https", "http", "git", "www"):
            return {"owner": owner, "name": name}

    return None
