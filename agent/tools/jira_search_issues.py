import asyncio
from typing import Any

from ..utils.jira import search_issues


def jira_search_issues(jql: str, max_results: int = 50) -> dict[str, Any]:
    """Search Jira issues using JQL (Jira Query Language).

    Args:
        jql: JQL query string. Examples:
            - "project = PROJ AND status = Open"
            - "assignee = currentUser() AND sprint in openSprints()"
            - "created >= -7d ORDER BY created DESC"
        max_results: Maximum number of results to return (default: 50, max: 100)

    Returns:
        Dictionary containing:
        - issues: List of matching issues
        - total: Total number of matching issues
        - start_at: Starting index for pagination
        - max_results: Number of results returned
        - error: Error message if the request failed
    """
    return asyncio.run(search_issues(jql, max_results))
