import asyncio
from typing import Any

from ..utils.jira import get_transitions


def jira_get_transitions(issue_key: str) -> dict[str, Any]:
    """Get available workflow transitions for a Jira issue.

    Use this to see what status changes are available before calling jira_transition_issue.

    Args:
        issue_key: The issue key (e.g., "PROJ-123")

    Returns:
        Dictionary containing:
        - transitions: List of available transitions with:
            - id: Transition ID (needed for jira_transition_issue)
            - name: Display name of the transition
            - to: Target status information
        - error: Error message if the request failed
    """
    return asyncio.run(get_transitions(issue_key))
