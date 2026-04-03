import asyncio
from typing import Any

from ..utils.jira import add_comment


def jira_add_comment(issue_key: str, comment: str) -> dict[str, Any]:
    """Add a comment to a Jira issue.

    Args:
        issue_key: The issue key (e.g., "PROJ-123")
        comment: Comment text to add

    Returns:
        Dictionary containing:
        - success: Boolean indicating if the comment was added
        - comment: Created comment details including id, author, created time
        - error: Error message if the request failed
    """
    return asyncio.run(add_comment(issue_key, comment))
