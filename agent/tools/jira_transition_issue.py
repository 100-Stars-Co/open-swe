import asyncio
from typing import Any

from ..utils.jira import transition_issue


def jira_transition_issue(
    issue_key: str,
    transition_id: str,
    comment: str | None = None,
) -> dict[str, Any]:
    """Transition a Jira issue to a new status.

    Use jira_get_transitions first to get the available transition IDs.

    Args:
        issue_key: The issue key (e.g., "PROJ-123")
        transition_id: The transition ID from jira_get_transitions
        comment: Optional comment to add with the transition

    Returns:
        Dictionary containing:
        - success: Boolean indicating if the transition was successful
        - error: Error message if the request failed
    """
    return asyncio.run(transition_issue(issue_key, transition_id, comment))
