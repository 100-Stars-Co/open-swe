import asyncio
from typing import Any

from ..utils.jira import update_issue


def jira_update_issue(
    issue_key: str,
    summary: str | None = None,
    description: str | None = None,
    priority: str | None = None,
    assignee: str | None = None,
    labels: list[str] | None = None,
) -> dict[str, Any]:
    """Update an existing Jira issue.

    Only provide the fields you want to update. Fields not provided will remain unchanged.

    Args:
        issue_key: The issue key (e.g., "PROJ-123")
        summary: New summary/title
        description: New description
        priority: New priority name (e.g., "Highest", "High", "Medium", "Low", "Lowest")
        assignee: New assignee account ID (Cloud) or username (Server).
                 Use empty string to unassign.
        labels: New list of labels (replaces existing labels entirely)

    Returns:
        Dictionary containing:
        - success: Boolean indicating if update was successful
        - error: Error message if the request failed
    """
    return asyncio.run(
        update_issue(
            issue_key=issue_key,
            summary=summary,
            description=description,
            priority=priority,
            assignee=assignee,
            labels=labels,
        )
    )
