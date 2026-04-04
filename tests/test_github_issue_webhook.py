from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from agent import webapp
from agent.utils import github_comments
from agent.utils.github_comments import (
    UNTRUSTED_GITHUB_COMMENT_CLOSE_TAG,
    UNTRUSTED_GITHUB_COMMENT_OPEN_TAG,
)

_TEST_WEBHOOK_SECRET = "test-secret-for-webhook"


def _sign_body(body: bytes, secret: str = _TEST_WEBHOOK_SECRET) -> str:
    """Compute the X-Hub-Signature-256 header value for raw bytes."""
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={sig}"


def _post_github_webhook(client: TestClient, event_type: str, payload: dict) -> object:
    """Send a signed GitHub webhook POST request."""
    body = json.dumps(payload, separators=(",", ":")).encode()
    return client.post(
        "/webhooks/github",
        content=body,
        headers={
            "X-GitHub-Event": event_type,
            "X-Hub-Signature-256": _sign_body(body),
            "Content-Type": "application/json",
        },
    )


def test_generate_thread_id_from_github_issue_is_deterministic() -> None:
    first = webapp.generate_thread_id_from_github_issue("12345")
    second = webapp.generate_thread_id_from_github_issue("12345")

    assert first == second
    assert len(first) == 36


def test_build_github_issue_prompt_includes_issue_context() -> None:
    prompt = webapp.build_github_issue_prompt(
        {"owner": "langchain-ai", "name": "open-swe"},
        42,
        "12345",
        "Fix the flaky test",
        "The test is failing intermittently.",
        [
            {
                "author": "octocat",
                "body": "Please take a look",
                "created_at": "2026-03-09T00:00:00Z",
            }
        ],
        github_login="octocat",
    )

    assert "Fix the flaky test" in prompt
    assert "The test is failing intermittently." in prompt
    assert "Please take a look" in prompt
    assert "github_comment" in prompt


def test_build_github_issue_followup_prompt_only_includes_comment() -> None:
    # bracesproul is not in GITHUB_USER_EMAIL_MAP so the body is wrapped in untrusted tags
    prompt = webapp.build_github_issue_followup_prompt("bracesproul", "Please handle this")

    expected = (
        f"**bracesproul:**\n"
        f"{UNTRUSTED_GITHUB_COMMENT_OPEN_TAG}\n"
        f"Please handle this\n"
        f"{UNTRUSTED_GITHUB_COMMENT_CLOSE_TAG}"
    )
    assert prompt == expected
    assert "## Repository" not in prompt
    assert "## Title" not in prompt


def test_github_webhook_accepts_issue_events(monkeypatch) -> None:
    called: dict[str, object] = {}

    async def fake_process_github_issue(payload: dict[str, object], event_type: str) -> None:
        called["payload"] = payload
        called["event_type"] = event_type

    monkeypatch.setattr(webapp, "process_github_issue", fake_process_github_issue)
    monkeypatch.setattr(webapp, "GITHUB_WEBHOOK_SECRET", _TEST_WEBHOOK_SECRET)

    client = TestClient(webapp.app)
    response = _post_github_webhook(
        client,
        "issues",
        {
            "action": "opened",
            "issue": {
                "id": 12345,
                "number": 42,
                "title": "@openswe fix the flaky test",
                "body": "The test is failing intermittently.",
            },
            "repository": {"owner": {"login": "langchain-ai"}, "name": "open-swe"},
            "sender": {"login": "octocat"},
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    assert called["event_type"] == "issues"


def test_github_webhook_ignores_issue_events_without_body_or_title_change(
    monkeypatch,
) -> None:
    called = False

    async def fake_process_github_issue(payload: dict[str, object], event_type: str) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(webapp, "process_github_issue", fake_process_github_issue)
    monkeypatch.setattr(webapp, "GITHUB_WEBHOOK_SECRET", _TEST_WEBHOOK_SECRET)

    client = TestClient(webapp.app)
    response = _post_github_webhook(
        client,
        "issues",
        {
            "action": "edited",
            "changes": {"labels": {"from": []}},
            "issue": {
                "id": 12345,
                "number": 42,
                "title": "@openswe fix the flaky test",
                "body": "The test is failing intermittently.",
            },
            "repository": {"owner": {"login": "langchain-ai"}, "name": "open-swe"},
            "sender": {"login": "octocat"},
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "ignored"
    assert called is False


def test_github_webhook_accepts_issue_comment_events(monkeypatch) -> None:
    called: dict[str, object] = {}

    async def fake_process_github_issue(payload: dict[str, object], event_type: str) -> None:
        called["payload"] = payload
        called["event_type"] = event_type

    monkeypatch.setattr(webapp, "process_github_issue", fake_process_github_issue)
    monkeypatch.setattr(webapp, "GITHUB_WEBHOOK_SECRET", _TEST_WEBHOOK_SECRET)

    client = TestClient(webapp.app)
    response = _post_github_webhook(
        client,
        "issue_comment",
        {
            "issue": {"id": 12345, "number": 42, "title": "Fix the flaky test"},
            "comment": {"body": "@openswe please handle this"},
            "repository": {"owner": {"login": "langchain-ai"}, "name": "open-swe"},
            "sender": {"login": "octocat"},
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    assert called["event_type"] == "issue_comment"


def test_process_github_issue_uses_resolved_user_token_for_reaction(
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}

    async def fake_get_or_resolve_thread_github_token(thread_id: str, email: str) -> str | None:
        captured["thread_id"] = thread_id
        captured["email"] = email
        return "user-token"

    async def fake_get_github_app_installation_token() -> str | None:
        return None

    async def fake_react_to_github_comment(
        repo_config: dict[str, str],
        comment_id: int,
        *,
        event_type: str,
        token: str,
        pull_number: int | None = None,
        node_id: str | None = None,
    ) -> bool:
        captured["reaction_token"] = token
        captured["comment_id"] = comment_id
        return True

    async def fake_fetch_issue_comments(
        repo_config: dict[str, str], issue_number: int, *, token: str | None = None
    ) -> list[dict[str, object]]:
        captured["fetch_token"] = token
        return []

    async def fake_is_thread_active(thread_id: str) -> bool:
        return False

    class _FakeRunsClient:
        async def create(self, *args, **kwargs) -> None:
            captured["run_created"] = True

    class _FakeLangGraphClient:
        runs = _FakeRunsClient()

    monkeypatch.setattr(
        webapp,
        "_get_or_resolve_thread_github_token",
        fake_get_or_resolve_thread_github_token,
    )
    monkeypatch.setattr(
        webapp,
        "get_github_app_installation_token",
        fake_get_github_app_installation_token,
    )
    monkeypatch.setattr(webapp, "_thread_exists", lambda thread_id: asyncio.sleep(0, result=False))
    monkeypatch.setattr(webapp, "react_to_github_comment", fake_react_to_github_comment)
    monkeypatch.setattr(webapp, "fetch_issue_comments", fake_fetch_issue_comments)
    monkeypatch.setattr(webapp, "is_thread_active", fake_is_thread_active)
    monkeypatch.setattr(webapp, "get_client", lambda url: _FakeLangGraphClient())
    monkeypatch.setattr(webapp, "GITHUB_USER_EMAIL_MAP", {"octocat": "octocat@example.com"})

    asyncio.run(
        webapp.process_github_issue(
            {
                "issue": {
                    "id": 12345,
                    "number": 42,
                    "title": "Fix the flaky test",
                    "body": "The test is failing intermittently.",
                    "html_url": "https://github.com/langchain-ai/open-swe/issues/42",
                },
                "comment": {"id": 999, "body": "@openswe please handle this"},
                "repository": {"owner": {"login": "langchain-ai"}, "name": "open-swe"},
                "sender": {"login": "octocat"},
            },
            "issue_comment",
        )
    )

    assert captured["reaction_token"] == "user-token"
    assert captured["fetch_token"] == "user-token"
    assert captured["comment_id"] == 999
    assert captured["run_created"] is True


def test_process_github_issue_existing_thread_uses_followup_prompt(monkeypatch) -> None:
    captured: dict[str, object] = {}

    async def fake_get_or_resolve_thread_github_token(thread_id: str, email: str) -> str | None:
        return "user-token"

    async def fake_get_github_app_installation_token() -> str | None:
        return None

    async def fake_react_to_github_comment(
        repo_config: dict[str, str],
        comment_id: int,
        *,
        event_type: str,
        token: str,
        pull_number: int | None = None,
        node_id: str | None = None,
    ) -> bool:
        return True

    async def fake_fetch_issue_comments(
        repo_config: dict[str, str], issue_number: int, *, token: str | None = None
    ) -> list[dict[str, object]]:
        raise AssertionError("fetch_issue_comments should not be called for follow-up prompts")

    async def fake_thread_exists(thread_id: str) -> bool:
        return True

    async def fake_is_thread_active(thread_id: str) -> bool:
        return False

    class _FakeRunsClient:
        async def create(self, *args, **kwargs) -> None:
            captured["prompt"] = kwargs["input"]["messages"][0]["content"]

    class _FakeLangGraphClient:
        runs = _FakeRunsClient()

    monkeypatch.setattr(
        webapp,
        "_get_or_resolve_thread_github_token",
        fake_get_or_resolve_thread_github_token,
    )
    monkeypatch.setattr(
        webapp,
        "get_github_app_installation_token",
        fake_get_github_app_installation_token,
    )
    monkeypatch.setattr(webapp, "_thread_exists", fake_thread_exists)
    monkeypatch.setattr(webapp, "react_to_github_comment", fake_react_to_github_comment)
    monkeypatch.setattr(webapp, "fetch_issue_comments", fake_fetch_issue_comments)
    monkeypatch.setattr(webapp, "is_thread_active", fake_is_thread_active)
    monkeypatch.setattr(webapp, "get_client", lambda url: _FakeLangGraphClient())
    monkeypatch.setattr(webapp, "GITHUB_USER_EMAIL_MAP", {"octocat": "octocat@example.com"})
    monkeypatch.setattr(
        github_comments, "GITHUB_USER_EMAIL_MAP", {"octocat": "octocat@example.com"}
    )

    asyncio.run(
        webapp.process_github_issue(
            {
                "issue": {
                    "id": 12345,
                    "number": 42,
                    "title": "Fix the flaky test",
                    "body": "The test is failing intermittently.",
                    "html_url": "https://github.com/langchain-ai/open-swe/issues/42",
                },
                "comment": {
                    "id": 999,
                    "body": "@openswe please handle this",
                    "user": {"login": "octocat"},
                },
                "repository": {"owner": {"login": "langchain-ai"}, "name": "open-swe"},
                "sender": {"login": "octocat"},
            },
            "issue_comment",
        )
    )

    assert captured["prompt"] == "**octocat:**\n@openswe please handle this"
    assert "## Repository" not in captured["prompt"]


# ---------------------------------------------------------------------------
# Tests using the captured production webhook payload (github_webhook_debug.json)
# ---------------------------------------------------------------------------

_DEBUG_PAYLOAD_FILE = Path(__file__).parent.parent / "github_webhook_debug.json"

# Load once at import time so that tests which call _post_github_webhook
# (which previously triggered file writes via the now-removed debug code)
# cannot corrupt the reference data used by later tests.
with _DEBUG_PAYLOAD_FILE.open() as _f:
    _DEBUG_PAYLOAD: dict[str, Any] = json.load(_f)


def _load_debug_payload() -> dict[str, Any]:
    return _DEBUG_PAYLOAD


def test_github_webhook_accepts_debug_issue_comment_payload(monkeypatch) -> None:
    """Webhook endpoint must accept the real captured issue_comment payload."""
    called: dict[str, Any] = {}

    async def fake_process_github_issue(payload: dict[str, Any], event_type: str) -> None:
        called["payload"] = payload
        called["event_type"] = event_type

    monkeypatch.setattr(webapp, "process_github_issue", fake_process_github_issue)
    monkeypatch.setattr(webapp, "GITHUB_WEBHOOK_SECRET", _TEST_WEBHOOK_SECRET)

    debug_data = _load_debug_payload()
    payload = debug_data["body"]
    event_type = debug_data["headers"]["x-github-event"]

    client = TestClient(webapp.app)
    response = _post_github_webhook(client, event_type, payload)

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "accepted", f"Unexpected status: {data}"
    assert called.get("event_type") == "issue_comment"


def test_process_github_issue_with_debug_payload_builds_expected_prompt(
    monkeypatch,
) -> None:
    """process_github_issue must build a coherent prompt from the production payload."""
    captured: dict[str, Any] = {}

    async def fake_get_or_resolve_thread_github_token(thread_id: str, email: str) -> str | None:
        captured["email"] = email
        return "bot-token"

    async def fake_get_github_app_installation_token() -> str | None:
        return "app-token"

    async def fake_react_to_github_comment(
        repo_config: dict[str, str],
        comment_id: int,
        *,
        event_type: str,
        token: str,
        pull_number: int | None = None,
        node_id: str | None = None,
    ) -> bool:
        captured["reacted"] = True
        return True

    async def fake_fetch_issue_comments(
        repo_config: dict[str, str], issue_number: int, *, token: str | None = None
    ) -> list[dict[str, Any]]:
        # Return the triggering comment as the only comment
        return [
            {
                "body": "@openswe Please implements this jira task: https://100star.atlassian.net/jira/software/projects/EF100/boards/17/backlog?selectedIssue=EF100-1815",
                "author": "puvanath",
                "created_at": "2026-04-04T09:32:15Z",
                "comment_id": 4186839365,
            }
        ]

    async def fake_thread_exists(thread_id: str) -> bool:
        return False

    async def fake_is_thread_active(thread_id: str) -> bool:
        return False

    class _FakeRunsClient:
        async def create(self, thread_id: str, agent: str, **kwargs: Any) -> dict[str, str]:
            captured["thread_id"] = thread_id
            captured["prompt"] = kwargs["input"]["messages"][0]["content"]
            return {"run_id": "fake-run-id"}

    class _FakeLangGraphClient:
        runs = _FakeRunsClient()

    monkeypatch.setattr(
        webapp,
        "_get_or_resolve_thread_github_token",
        fake_get_or_resolve_thread_github_token,
    )
    monkeypatch.setattr(
        webapp,
        "get_github_app_installation_token",
        fake_get_github_app_installation_token,
    )
    monkeypatch.setattr(webapp, "_thread_exists", fake_thread_exists)
    monkeypatch.setattr(webapp, "react_to_github_comment", fake_react_to_github_comment)
    monkeypatch.setattr(webapp, "fetch_issue_comments", fake_fetch_issue_comments)
    monkeypatch.setattr(webapp, "is_thread_active", fake_is_thread_active)
    monkeypatch.setattr(webapp, "get_client", lambda url: _FakeLangGraphClient())
    # puvanath is already in the real GITHUB_USER_EMAIL_MAP but patch both for isolation
    monkeypatch.setattr(webapp, "GITHUB_USER_EMAIL_MAP", {"puvanath": "puvanath@100stars.com"})
    monkeypatch.setattr(
        github_comments, "GITHUB_USER_EMAIL_MAP", {"puvanath": "puvanath@100stars.com"}
    )

    debug_data = _load_debug_payload()
    payload = debug_data["body"]

    asyncio.run(webapp.process_github_issue(payload, "issue_comment"))

    # Email resolved correctly from sender login
    assert captured["email"] == "puvanath@100stars.com"
    # Eyes reaction was added to the comment
    assert captured.get("reacted") is True
    # Prompt built with correct repo / issue context
    prompt = captured["prompt"]
    assert "100-Stars-Co/goal-tracking-agent-api" in prompt
    assert "EF100-1815" in prompt
    # puvanath is trusted so body must NOT be wrapped in untrusted tags
    assert UNTRUSTED_GITHUB_COMMENT_OPEN_TAG not in prompt
    assert "## Repository" in prompt
    assert "## GitHub Issue: #64" in prompt


def test_process_github_issue_debug_payload_followup_when_thread_exists(
    monkeypatch,
) -> None:
    """When the thread already exists the agent receives only the new comment."""
    captured: dict[str, Any] = {}

    async def fake_get_or_resolve_thread_github_token(thread_id: str, email: str) -> str | None:
        return "bot-token"

    async def fake_get_github_app_installation_token() -> str | None:
        return "app-token"

    async def fake_react_to_github_comment(
        repo_config: dict[str, str],
        comment_id: int,
        *,
        event_type: str,
        token: str,
        pull_number: int | None = None,
        node_id: str | None = None,
    ) -> bool:
        return True

    async def fake_thread_exists(thread_id: str) -> bool:
        return True  # thread already exists → followup path

    async def fake_is_thread_active(thread_id: str) -> bool:
        return False

    class _FakeRunsClient:
        async def create(self, thread_id: str, agent: str, **kwargs: Any) -> dict[str, str]:
            captured["prompt"] = kwargs["input"]["messages"][0]["content"]
            return {"run_id": "fake-run-id"}

    class _FakeLangGraphClient:
        runs = _FakeRunsClient()

    monkeypatch.setattr(
        webapp,
        "_get_or_resolve_thread_github_token",
        fake_get_or_resolve_thread_github_token,
    )
    monkeypatch.setattr(
        webapp,
        "get_github_app_installation_token",
        fake_get_github_app_installation_token,
    )
    monkeypatch.setattr(webapp, "_thread_exists", fake_thread_exists)
    monkeypatch.setattr(webapp, "react_to_github_comment", fake_react_to_github_comment)
    monkeypatch.setattr(webapp, "is_thread_active", fake_is_thread_active)
    monkeypatch.setattr(webapp, "get_client", lambda url: _FakeLangGraphClient())
    monkeypatch.setattr(webapp, "GITHUB_USER_EMAIL_MAP", {"puvanath": "puvanath@100stars.com"})
    monkeypatch.setattr(
        github_comments, "GITHUB_USER_EMAIL_MAP", {"puvanath": "puvanath@100stars.com"}
    )

    debug_data = _load_debug_payload()
    payload = debug_data["body"]

    asyncio.run(webapp.process_github_issue(payload, "issue_comment"))

    prompt = captured["prompt"]
    # Follow-up prompt contains sender and comment body — not the full issue context
    assert "puvanath" in prompt
    assert "EF100-1815" in prompt
    assert "## Repository" not in prompt
    # puvanath is trusted so no untrusted wrapping
    assert UNTRUSTED_GITHUB_COMMENT_OPEN_TAG not in prompt
