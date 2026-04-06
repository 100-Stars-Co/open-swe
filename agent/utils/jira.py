"""Jira API utilities."""

from __future__ import annotations

import base64
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

JIRA_BASE_URL = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
JIRA_API_TOKEN = os.environ.get("JIRA_API_TOKEN", "")
JIRA_USER_EMAIL = os.environ.get("JIRA_USER_EMAIL", "")
JIRA_TYPE = os.environ.get("JIRA_TYPE", "cloud").lower()


def _get_api_url() -> str:
    """Get the Jira API URL based on the configured type."""
    if not JIRA_BASE_URL:
        return ""
    # Cloud uses API v3, Server uses API v2
    api_version = "3" if JIRA_TYPE == "cloud" else "2"
    return f"{JIRA_BASE_URL}/rest/api/{api_version}"


def _headers() -> dict[str, str]:
    """Get authentication headers for Jira API."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    if not JIRA_API_TOKEN:
        return headers

    if JIRA_TYPE == "cloud":
        # Cloud uses Basic Auth with email:token
        credentials = base64.b64encode(f"{JIRA_USER_EMAIL}:{JIRA_API_TOKEN}".encode()).decode()
        headers["Authorization"] = f"Basic {credentials}"
    else:
        # Server uses Bearer token (PAT)
        headers["Authorization"] = f"Bearer {JIRA_API_TOKEN}"

    return headers


def _check_config() -> dict[str, Any] | None:
    """Check if Jira is properly configured."""
    if not JIRA_BASE_URL:
        return {"error": "JIRA_BASE_URL is not set"}
    if not JIRA_API_TOKEN:
        return {"error": "JIRA_API_TOKEN is not set"}
    if JIRA_TYPE == "cloud" and not JIRA_USER_EMAIL:
        return {"error": "JIRA_USER_EMAIL is required for Jira Cloud"}
    return None


async def _api_request(
    method: str,
    endpoint: str,
    json_data: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute an HTTP request against the Jira API."""
    import json as json_module

    config_error = _check_config()
    if config_error:
        return config_error

    api_url = _get_api_url()
    url = f"{api_url}{endpoint}"

    # Prepare request kwargs
    request_kwargs: dict[str, Any] = {
        "method": method,
        "url": url,
        "headers": _headers(),
        "params": params,
        "timeout": 30.0,
    }

    # Use content= instead of json= to avoid httpx adding extra encoding
    if json_data is not None:
        request_kwargs["content"] = json_module.dumps(json_data)

    async with httpx.AsyncClient(trust_env=False) as http_client:
        try:
            response = await http_client.request(**request_kwargs)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            error_detail = e.response.text
            return {"error": f"HTTP {e.response.status_code}: {error_detail}"}
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}


async def get_issue(issue_key: str) -> dict[str, Any]:
    """Get a Jira issue by its key.

    Args:
        issue_key: The Jira issue key (e.g., "PROJ-123")

    Returns:
        Dictionary with issue details or error
    """
    endpoint = f"/issue/{issue_key}"
    result = await _api_request("GET", endpoint)
    if "error" in result:
        return result
    return {"issue": result}


async def search_issues(
    jql: str,
    max_results: int = 50,
    start_at: int = 0,
) -> dict[str, Any]:
    """Search Jira issues using JQL.

    Args:
        jql: JQL query string (e.g., "project = PROJ AND status = Open")
        max_results: Maximum number of results (default: 50)
        start_at: Starting index for pagination (default: 0)

    Returns:
        Dictionary with list of issues or error
    """
    # Use POST to /search/jql endpoint (required for Jira Cloud as of 2024)
    json_data = {
        "jql": jql,
        "maxResults": max_results,
        "startAt": start_at,
        "fields": [
            "summary",
            "status",
            "assignee",
            "created",
            "updated",
            "issuetype",
            "priority",
            "description",
        ],
    }
    result = await _api_request("POST", "/search/jql", json_data=json_data)
    if "error" in result:
        return result
    return {
        "issues": result.get("issues", []),
        "total": result.get("total", 0),
        "start_at": result.get("startAt", 0),
        "max_results": result.get("maxResults", max_results),
    }


async def create_issue(
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
        issue_type: Issue type name (e.g., "Task", "Story", "Bug")
        priority: Priority name (e.g., "High", "Medium", "Low")
        assignee: Account ID or username to assign the issue to
        labels: List of label strings
        parent: Parent issue key (for sub-tasks)

    Returns:
        Dictionary with created issue details or error
    """
    fields: dict[str, Any] = {
        "project": {"key": project_key},
        "summary": summary,
        "issuetype": {"name": issue_type},
    }

    if description:
        # Jira Cloud/Server v3 uses Atlassian Document Format (ADF)
        # For simplicity, we use the plain text description
        if JIRA_TYPE == "cloud":
            fields["description"] = {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": description}],
                    }
                ],
            }
        else:
            fields["description"] = description

    if priority:
        fields["priority"] = {"name": priority}

    if assignee:
        if JIRA_TYPE == "cloud":
            fields["assignee"] = {"accountId": assignee}
        else:
            fields["assignee"] = {"name": assignee}

    if labels:
        fields["labels"] = labels

    if parent:
        fields["parent"] = {"key": parent}

    result = await _api_request("POST", "/issue", json_data={"fields": fields})
    if "error" in result:
        return result
    return {"success": True, "issue": result}


async def update_issue(
    issue_key: str,
    summary: str | None = None,
    description: str | None = None,
    priority: str | None = None,
    assignee: str | None = None,
    labels: list[str] | None = None,
) -> dict[str, Any]:
    """Update an existing Jira issue.

    Args:
        issue_key: The issue key (e.g., "PROJ-123")
        summary: New summary/title
        description: New description
        priority: New priority name
        assignee: New assignee account ID or username
        labels: New list of labels (replaces existing)

    Returns:
        Dictionary with success status or error
    """
    fields: dict[str, Any] = {}

    if summary:
        fields["summary"] = summary

    if description:
        if JIRA_TYPE == "cloud":
            fields["description"] = {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": description}],
                    }
                ],
            }
        else:
            fields["description"] = description

    if priority:
        fields["priority"] = {"name": priority}

    if assignee:
        if JIRA_TYPE == "cloud":
            fields["assignee"] = {"accountId": assignee}
        else:
            fields["assignee"] = {"name": assignee}

    if labels:
        fields["labels"] = labels

    if not fields:
        return {"error": "No fields to update"}

    endpoint = f"/issue/{issue_key}"
    result = await _api_request("PUT", endpoint, json_data={"fields": fields})
    if "error" in result:
        return result
    return {"success": True}


async def add_comment(issue_key: str, comment: str) -> dict[str, Any]:
    """Add a comment to a Jira issue.

    Args:
        issue_key: The issue key (e.g., "PROJ-123")
        comment: Comment text

    Returns:
        Dictionary with created comment or error
    """
    endpoint = f"/issue/{issue_key}/comment"

    if JIRA_TYPE == "cloud":
        body = {
            "type": "doc",
            "version": 1,
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": comment}],
                }
            ],
        }
    else:
        body = comment

    result = await _api_request("POST", endpoint, json_data={"body": body})
    if "error" in result:
        return result
    return {"success": True, "comment": result}


async def get_transitions(issue_key: str) -> dict[str, Any]:
    """Get available workflow transitions for an issue.

    Args:
        issue_key: The issue key (e.g., "PROJ-123")

    Returns:
        Dictionary with available transitions or error
    """
    endpoint = f"/issue/{issue_key}/transitions"
    result = await _api_request("GET", endpoint)
    if "error" in result:
        return result
    return {"transitions": result.get("transitions", [])}


async def transition_issue(
    issue_key: str,
    transition_id: str,
    comment: str | None = None,
) -> dict[str, Any]:
    """Transition a Jira issue to a new status.

    Args:
        issue_key: The issue key (e.g., "PROJ-123")
        transition_id: The transition ID (use get_transitions to find)
        comment: Optional comment to add with the transition

    Returns:
        Dictionary with success status or error
    """
    endpoint = f"/issue/{issue_key}/transitions"
    data: dict[str, Any] = {"transition": {"id": transition_id}}

    if comment:
        if JIRA_TYPE == "cloud":
            body = {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": comment}],
                    }
                ],
            }
        else:
            body = comment
        data["update"] = {"comment": [{"add": {"body": body}}]}

    result = await _api_request("POST", endpoint, json_data=data)
    if "error" in result:
        return result
    return {"success": True}
