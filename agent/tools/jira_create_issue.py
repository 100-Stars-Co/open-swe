import asyncio
from typing import Any

from ..utils.jira import create_issue


def jira_create_issue(
    project_key: str,
    summary: str,
    description: str | None = None,
    issue_type: str = "Task",
    priority: str | None = None,
    assignee: str | None = None,
    labels: list[str] | None = None,
    parent: str | None = None,
) -> dict[str, Any]:
    """Create a new Jira issue.

    Args:
        project_key: The project key (e.g., "PROJ")
        summary: Issue summary/title
        description: Issue description
        issue_type: Issue type name (e.g., "Task", "Story", "Bug", "Epic", "Sub-task")
        priority: Priority name (e.g., "Highest", "High", "Medium", "Low", "Lowest")
        assignee: Account ID (Cloud) or username (Server) to assign the issue to.
                 Use empty string to unassign.
        labels: List of label strings to apply
        parent: Parent issue key (for sub-tasks)

    Returns:
        Dictionary containing:
        - success: Boolean indicating if creation was successful
        - issue: Created issue details including key, id, and self URL
        - error: Error message if the request failed
    """
    return asyncio.run(
        create_issue(
            project_key=project_key,
            summary=summary,
            description=description,
            issue_type=issue_type,
            priority=priority,
            assignee=assignee,
            labels=labels,
            parent=parent,
        )
    )
