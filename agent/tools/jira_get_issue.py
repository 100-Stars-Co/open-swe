import asyncio
from typing import Any

from ..utils.jira import get_issue


def jira_get_issue(issue_key: str) -> dict[str, Any]:
    """Get a Jira issue by its key.

    Args:
        issue_key: The Jira issue key (e.g., "PROJ-123")

    Returns:
        Dictionary with 'issue' containing full issue details including:
        - key: Issue key (e.g., "PROJ-123")
        - fields: Issue fields including summary, description, status, assignee, etc.
        - error: Error message if the request failed
    """
    return asyncio.run(get_issue(issue_key))
