"""Tests for Jira webhook functionality."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent import webapp
from agent.utils import jira_webhook

_TEST_WEBHOOK_SECRET = "test-secret-for-jira-webhook"


class TestJiraWebhookVerification:
    """Test webhook secret verification."""

    def test_verify_secret_matches(self) -> None:
        payload = b"test payload"
        secret = "my-secret"
        provided = "my-secret"

        result = jira_webhook.verify_jira_webhook_secret(payload, secret, provided)
        assert result is True

    def test_verify_secret_no_match(self) -> None:
        payload = b"test payload"
        secret = "my-secret"
        provided = "wrong-secret"

        result = jira_webhook.verify_jira_webhook_secret(payload, secret, provided)
        assert result is False

    def test_verify_secret_empty_config_allows_any(self) -> None:
        """When JIRA_WEBHOOK_SECRET is not set, accept any secret."""
        payload = b"test payload"
        secret = ""
        provided = ""

        result = jira_webhook.verify_jira_webhook_secret(payload, secret, provided)
        assert result is True

    def test_verify_secret_missing_header_when_configured(self) -> None:
        payload = b"test payload"
        secret = "my-secret"
        provided = ""

        result = jira_webhook.verify_jira_webhook_secret(payload, secret, provided)
        assert result is False


class TestThreadIdGeneration:
    """Test thread ID generation."""

    def test_thread_id_is_deterministic(self) -> None:
        first = jira_webhook.generate_thread_id_from_jira_issue("PROJ-123")
        second = jira_webhook.generate_thread_id_from_jira_issue("PROJ-123")

        assert first == second
        assert len(first) == 36  # UUID format

    def test_thread_id_different_for_different_issues(self) -> None:
        id1 = jira_webhook.generate_thread_id_from_jira_issue("PROJ-123")
        id2 = jira_webhook.generate_thread_id_from_jira_issue("PROJ-124")

        assert id1 != id2


class TestPayloadParsing:
    """Test webhook payload parsing."""

    def test_parse_valid_payload(self) -> None:
        payload = {
            "issue_key": "PROJ-123",
            "issue_summary": "Test Issue",
            "comment_body": "Please fix this",
            "comment_author": "John Doe",
            "comment_author_email": "john@example.com",
            "project_key": "PROJ",
            "issue_url": "https://example.atlassian.net/browse/PROJ-123",
        }

        result = jira_webhook.parse_jira_webhook_payload(payload)

        assert result is not None
        assert result["issue_key"] == "PROJ-123"
        assert result["issue_summary"] == "Test Issue"
        assert result["comment_body"] == "Please fix this"
        assert result["comment_author"] == "John Doe"
        assert result["comment_author_email"] == "john@example.com"

    def test_parse_missing_issue_key(self) -> None:
        payload = {
            "issue_summary": "Test Issue",
            "comment_body": "Please fix this",
        }

        result = jira_webhook.parse_jira_webhook_payload(payload)

        assert result is None

    def test_parse_empty_payload(self) -> None:
        result = jira_webhook.parse_jira_webhook_payload({})

        assert result is None

    def test_parse_invalid_payload_type(self) -> None:
        result = jira_webhook.parse_jira_webhook_payload("invalid")

        assert result is None


class TestBotMentionDetection:
    """Test bot mention detection."""

    def test_contains_openswe_mention(self) -> None:
        assert jira_webhook.contains_bot_mention("@openswe please help") is True
        assert jira_webhook.contains_bot_mention("Hey @open-swe fix this") is True

    def test_no_mention(self) -> None:
        assert jira_webhook.contains_bot_mention("Please help") is False
        assert jira_webhook.contains_bot_mention("@otherbot help") is False

    def test_case_insensitive(self) -> None:
        assert jira_webhook.contains_bot_mention("@OPENSWE help") is True
        assert jira_webhook.contains_bot_mention("@Open-Swe help") is True


class TestRepoExtraction:
    """Test repository extraction from text."""

    def test_extract_from_github_url(self) -> None:
        text = "Please fix https://github.com/owner/repo"
        result = jira_webhook.extract_repo_from_text(text)

        assert result == {"owner": "owner", "name": "repo"}

    def test_extract_from_simple_pattern(self) -> None:
        text = "Fix this in owner/repo"
        result = jira_webhook.extract_repo_from_text(text)

        assert result == {"owner": "owner", "name": "repo"}

    def test_extract_no_match(self) -> None:
        text = "Just some text without a repo"
        result = jira_webhook.extract_repo_from_text(text)

        assert result is None

    def test_extract_ignores_url_prefixes(self) -> None:
        """Should not match https:// or http:// as owner."""
        text = "See https://github.com/owner/repo"
        result = jira_webhook.extract_repo_from_text(text)

        # Should match github URL pattern, not simple pattern
        assert result == {"owner": "owner", "name": "repo"}


class TestJiraWebhookEndpoint:
    """Test the Jira webhook endpoint."""

    @pytest.fixture
    def client(self, monkeypatch: pytest.MonkeyPatch) -> TestClient:
        monkeypatch.setattr(webapp, "JIRA_WEBHOOK_SECRET", _TEST_WEBHOOK_SECRET)
        return TestClient(webapp.app)

    def _post_jira_webhook(
        self, client: TestClient, payload: dict[str, Any], secret: str = _TEST_WEBHOOK_SECRET
    ) -> Any:
        """Send a Jira webhook POST request."""
        return client.post(
            "/webhooks/jira",
            json=payload,
            headers={"X-Jira-Webhook-Secret": secret},
        )

    def test_webhook_accepts_valid_request(self, client: TestClient) -> None:
        payload = {
            "issue_key": "PROJ-123",
            "issue_summary": "Test Issue",
            "comment_body": "@openswe please fix this in owner/repo",
            "comment_author": "John Doe",
        }

        response = self._post_jira_webhook(client, payload)

        assert response.status_code == 200
        assert response.json()["status"] == "accepted"

    def test_webhook_rejects_invalid_secret(self, client: TestClient) -> None:
        payload = {
            "issue_key": "PROJ-123",
            "issue_summary": "Test Issue",
            "comment_body": "@openswe please fix this",
        }

        response = self._post_jira_webhook(client, payload, secret="wrong-secret")

        assert response.status_code == 401

    def test_webhook_ignores_without_bot_mention(self, client: TestClient) -> None:
        payload = {
            "issue_key": "PROJ-123",
            "issue_summary": "Test Issue",
            "comment_body": "Just a regular comment",
            "comment_author": "John Doe",
        }

        response = self._post_jira_webhook(client, payload)

        assert response.status_code == 200
        assert response.json()["status"] == "ignored"

    def test_webhook_rejects_invalid_json(self, client: TestClient) -> None:
        response = client.post(
            "/webhooks/jira",
            content=b"not valid json",
            headers={"X-Jira-Webhook-Secret": _TEST_WEBHOOK_SECRET},
        )

        assert response.status_code == 200  # Returns error in body, not HTTP error
        assert response.json()["status"] == "error"

    def test_webhook_verify_endpoint(self, client: TestClient) -> None:
        response = client.get("/webhooks/jira")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"


class TestProcessJiraIssue:
    """Test the process_jira_issue function."""

    @pytest.mark.asyncio
    async def test_process_jira_issue_basic(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test basic processing flow."""
        # Mock dependencies
        mock_thread_active = False
        mock_run_created = {"run_id": "test-run-123"}
        trace_url_called = []

        async def mock_is_thread_active(thread_id: str) -> bool:
            return mock_thread_active

        async def mock_create_run(*args: Any, **kwargs: Any) -> dict[str, Any]:
            return mock_run_created

        async def mock_jira_add_comment(issue_key: str, comment: str) -> dict[str, Any]:
            trace_url_called.append(comment)
            return {"success": True}

        async def mock_jira_get_issue(issue_key: str) -> dict[str, Any]:
            return {
                "issue": {
                    "key": issue_key,
                    "self": "https://example.atlassian.net/rest/api/3/issue/12345",
                    "fields": {
                        "summary": "Test Issue",
                        "description": "Test description",
                    },
                }
            }

        def mock_get_trace_url(run_id: str) -> str:
            return f"https://trace.langchain.com/{run_id}"

        monkeypatch.setattr(webapp, "is_thread_active", mock_is_thread_active)
        monkeypatch.setattr(webapp, "jira_get_issue", mock_jira_get_issue)
        monkeypatch.setattr(webapp, "jira_add_comment", mock_jira_add_comment)
        monkeypatch.setattr(webapp, "get_trace_url", mock_get_trace_url)
        monkeypatch.setattr(webapp, "JIRA_WEBHOOK_SECRET", _TEST_WEBHOOK_SECRET)

        # Mock LangGraph client
        class MockRuns:
            async def create(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
                return mock_run_created

        class MockLangGraphClient:
            runs = MockRuns()

        import langgraph_sdk

        def mock_get_client(*args: Any, **kwargs: Any) -> MockLangGraphClient:
            return MockLangGraphClient()

        monkeypatch.setattr(langgraph_sdk, "get_client", mock_get_client)
        monkeypatch.setattr(webapp, "get_client", mock_get_client)

        issue_data = {
            "issue_key": "PROJ-123",
            "issue_summary": "Test Issue",
            "comment_body": "@openswe please fix",
            "comment_author": "John Doe",
            "comment_author_email": "john@example.com",
            "project_key": "PROJ",
        }
        repo_config = {"owner": "testowner", "name": "testrepo"}

        await webapp.process_jira_issue(issue_data, repo_config)

        # Verify trace comment was posted
        assert len(trace_url_called) == 1
        assert "On it!" in trace_url_called[0]

    async def test_process_jira_issue_thread_active_queues_message(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When the thread is busy, the prompt is queued rather than a new run created."""
        queued_messages: list[Any] = []
        runs_created: list[Any] = []

        async def mock_is_thread_active(thread_id: str) -> bool:
            return True  # Thread is busy

        async def mock_queue_message(thread_id: str, message_content: Any) -> bool:
            queued_messages.append({"thread_id": thread_id, "content": message_content})
            return True

        async def mock_jira_get_issue(issue_key: str) -> dict[str, Any]:
            return {
                "issue": {
                    "key": issue_key,
                    "self": "https://mycompany.atlassian.net/rest/api/3/issue/10001",
                    "fields": {"summary": "Login page crashes on Safari", "description": ""},
                }
            }

        monkeypatch.setattr(webapp, "is_thread_active", mock_is_thread_active)
        monkeypatch.setattr(webapp, "queue_message_for_thread", mock_queue_message)
        monkeypatch.setattr(webapp, "jira_get_issue", mock_jira_get_issue)
        monkeypatch.setattr(webapp, "jira_add_comment", lambda *a, **kw: None)

        issue_data = {
            "issue_key": "WEB-456",
            "issue_summary": "Login page crashes on Safari",
            "comment_body": "@openswe please fix this in owner/repo",
            "comment_author": "Alice Smith",
            "comment_author_email": "alice@example.com",
            "project_key": "WEB",
        }
        repo_config = {"owner": "owner", "name": "repo"}

        await webapp.process_jira_issue(issue_data, repo_config)

        # No run should be created — message was queued instead
        assert len(runs_created) == 0
        assert len(queued_messages) == 1
        queued = queued_messages[0]
        assert queued["thread_id"] == jira_webhook.generate_thread_id_from_jira_issue("WEB-456")
        assert "Login page crashes on Safari" in queued["content"]["text"]

    async def test_process_jira_issue_falls_back_to_reporter(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When no comment author is provided, reporter info from Jira API is used."""
        configurable_captured: list[Any] = []

        async def mock_is_thread_active(thread_id: str) -> bool:
            return False

        async def mock_jira_get_issue(issue_key: str) -> dict[str, Any]:
            return {
                "issue": {
                    "key": issue_key,
                    "self": "https://mycompany.atlassian.net/rest/api/3/issue/10002",
                    "fields": {
                        "summary": "Button label typo",
                        "description": "The Save button says 'Seve'.",
                        "reporter": {
                            "displayName": "Bob Reporter",
                            "emailAddress": "bob@example.com",
                        },
                    },
                }
            }

        class MockRuns:
            async def create(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
                configurable_captured.append(kwargs.get("config", {}).get("configurable", {}))
                return {"run_id": "run-fallback-999"}

        class MockLangGraphClient:
            runs = MockRuns()

        import langgraph_sdk

        monkeypatch.setattr(webapp, "is_thread_active", mock_is_thread_active)
        monkeypatch.setattr(webapp, "jira_get_issue", mock_jira_get_issue)
        monkeypatch.setattr(webapp, "jira_add_comment", lambda *a, **kw: None)
        monkeypatch.setattr(webapp, "get_trace_url", lambda run_id: None)
        monkeypatch.setattr(langgraph_sdk, "get_client", lambda **kw: MockLangGraphClient())
        monkeypatch.setattr(webapp, "get_client", lambda **kw: MockLangGraphClient())

        issue_data = {
            "issue_key": "UI-7",
            "issue_summary": "Button label typo",
            # No comment_author / comment_author_email — should fall back to reporter
            "comment_body": "",
            "comment_author": "",
            "comment_author_email": "",
        }
        repo_config = {"owner": "myorg", "name": "frontend"}

        await webapp.process_jira_issue(issue_data, repo_config)

        assert len(configurable_captured) == 1
        cfg = configurable_captured[0]
        assert cfg["user_email"] == "bob@example.com"
        assert cfg["jira_issue"]["triggering_user_name"] == "Bob Reporter"

    async def test_process_jira_issue_adf_description(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """ADF-formatted description (dict) is extracted to plain text in the prompt."""
        prompts_captured: list[str] = []

        async def mock_is_thread_active(thread_id: str) -> bool:
            return False

        async def mock_jira_get_issue(issue_key: str) -> dict[str, Any]:
            # Realistic Atlassian Document Format description
            adf_description = {
                "version": 1,
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {"type": "text", "text": "When a user clicks "},
                            {"type": "text", "text": "Submit", "marks": [{"type": "strong"}]},
                            {"type": "text", "text": ", the page redirects to a 500 error."},
                        ],
                    },
                    {
                        "type": "bulletList",
                        "content": [
                            {
                                "type": "listItem",
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "content": [
                                            {"type": "text", "text": "Steps to reproduce:"}
                                        ],
                                    }
                                ],
                            }
                        ],
                    },
                ],
            }
            return {
                "issue": {
                    "key": issue_key,
                    "self": "https://mycompany.atlassian.net/rest/api/3/issue/20001",
                    "fields": {
                        "summary": "Submit button causes 500 error",
                        "description": adf_description,
                    },
                }
            }

        class MockRuns:
            async def create(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
                # Capture the prompt from the input messages
                messages = kwargs.get("input", {}).get("messages", [])
                if messages:
                    content = messages[0].get("content", [])
                    if content and isinstance(content[0], dict):
                        prompts_captured.append(content[0].get("text", ""))
                return {"run_id": "run-adf-001"}

        class MockLangGraphClient:
            runs = MockRuns()

        import langgraph_sdk

        monkeypatch.setattr(webapp, "is_thread_active", mock_is_thread_active)
        monkeypatch.setattr(webapp, "jira_get_issue", mock_jira_get_issue)
        monkeypatch.setattr(webapp, "jira_add_comment", lambda *a, **kw: None)
        monkeypatch.setattr(webapp, "get_trace_url", lambda run_id: None)
        monkeypatch.setattr(langgraph_sdk, "get_client", lambda **kw: MockLangGraphClient())
        monkeypatch.setattr(webapp, "get_client", lambda **kw: MockLangGraphClient())

        issue_data = {
            "issue_key": "BUG-42",
            "issue_summary": "Submit button causes 500 error",
            "comment_body": "@openswe fix this",
            "comment_author": "Charlie Tester",
            "comment_author_email": "charlie@example.com",
        }
        repo_config = {"owner": "myorg", "name": "backend"}

        await webapp.process_jira_issue(issue_data, repo_config)

        assert len(prompts_captured) == 1
        prompt = prompts_captured[0]
        # ADF text nodes should be extracted and present in prompt
        assert "When a user clicks" in prompt
        assert "Submit" in prompt
        assert "the page redirects to a 500 error." in prompt
        assert "Steps to reproduce:" in prompt

    async def test_process_jira_issue_project_key_extracted_from_issue_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """project_key is extracted from issue_key (e.g. 'INFRA-99' -> 'INFRA') when absent."""
        configurable_captured: list[Any] = []

        async def mock_is_thread_active(thread_id: str) -> bool:
            return False

        async def mock_jira_get_issue(issue_key: str) -> dict[str, Any]:
            return {
                "issue": {
                    "key": issue_key,
                    "self": "https://mycompany.atlassian.net/rest/api/3/issue/30001",
                    "fields": {"summary": "Disk usage alert", "description": "Server at 95%."},
                }
            }

        class MockRuns:
            async def create(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
                configurable_captured.append(kwargs.get("config", {}).get("configurable", {}))
                return {"run_id": "run-proj-001"}

        class MockLangGraphClient:
            runs = MockRuns()

        import langgraph_sdk

        monkeypatch.setattr(webapp, "is_thread_active", mock_is_thread_active)
        monkeypatch.setattr(webapp, "jira_get_issue", mock_jira_get_issue)
        monkeypatch.setattr(webapp, "jira_add_comment", lambda *a, **kw: None)
        monkeypatch.setattr(webapp, "get_trace_url", lambda run_id: None)
        monkeypatch.setattr(langgraph_sdk, "get_client", lambda **kw: MockLangGraphClient())
        monkeypatch.setattr(webapp, "get_client", lambda **kw: MockLangGraphClient())

        # No project_key in payload — must be derived from issue_key
        issue_data = {
            "issue_key": "INFRA-99",
            "issue_summary": "Disk usage alert",
            "comment_body": "@openswe investigate",
            "comment_author": "Dave Ops",
            "comment_author_email": "dave@example.com",
            # project_key intentionally omitted
        }
        repo_config = {"owner": "myorg", "name": "infrastructure"}

        await webapp.process_jira_issue(issue_data, repo_config)

        assert len(configurable_captured) == 1
        cfg = configurable_captured[0]
        assert cfg["jira_issue"]["project_key"] == "INFRA"


class TestExtractTextFromADF:
    """Tests for _extract_text_from_adf — Atlassian Document Format parsing."""

    def test_simple_paragraph(self) -> None:
        adf = {
            "version": 1,
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "Hello, world!"}],
                }
            ],
        }
        result = webapp._extract_text_from_adf(adf)
        assert "Hello, world!" in result

    def test_multiple_text_nodes(self) -> None:
        adf = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "First sentence. "},
                        {"type": "text", "text": "Second sentence."},
                    ],
                }
            ],
        }
        result = webapp._extract_text_from_adf(adf)
        assert "First sentence." in result
        assert "Second sentence." in result

    def test_nested_bullet_list(self) -> None:
        adf = {
            "type": "doc",
            "content": [
                {
                    "type": "bulletList",
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "Item one"}],
                                }
                            ],
                        },
                        {
                            "type": "listItem",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "Item two"}],
                                }
                            ],
                        },
                    ],
                }
            ],
        }
        result = webapp._extract_text_from_adf(adf)
        assert "Item one" in result
        assert "Item two" in result

    def test_empty_doc_returns_empty_string(self) -> None:
        adf: dict[str, Any] = {"type": "doc", "content": []}
        result = webapp._extract_text_from_adf(adf)
        assert result == ""

    def test_non_text_nodes_are_ignored(self) -> None:
        """Nodes without a 'text' type (e.g. mention, emoji) should not cause errors."""
        adf = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "See "},
                        {"type": "mention", "attrs": {"id": "user123", "text": "@alice"}},
                        {"type": "text", "text": " for details."},
                    ],
                }
            ],
        }
        result = webapp._extract_text_from_adf(adf)
        assert "See" in result
        assert "for details." in result


class TestJiraWebhookOrgAllowlist:
    """Test org allowlist enforcement on the /webhooks/jira endpoint."""

    @pytest.fixture
    def client_with_allowlist(self, monkeypatch: pytest.MonkeyPatch) -> TestClient:
        monkeypatch.setattr(webapp, "JIRA_WEBHOOK_SECRET", _TEST_WEBHOOK_SECRET)
        # Only "allowedorg" is permitted
        monkeypatch.setattr(webapp, "ALLOWED_GITHUB_ORGS", frozenset(["allowedorg"]))
        return TestClient(webapp.app)

    def test_allowed_org_is_accepted(self, client_with_allowlist: TestClient) -> None:
        payload = {
            "issue_key": "SAFE-1",
            "issue_summary": "Allowed issue",
            "comment_body": "@openswe fix this in allowedorg/myrepo",
            "comment_author": "Eve Dev",
        }
        response = client_with_allowlist.post(
            "/webhooks/jira",
            json=payload,
            headers={"X-Jira-Webhook-Secret": _TEST_WEBHOOK_SECRET},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "accepted"

    def test_disallowed_org_is_ignored(self, client_with_allowlist: TestClient) -> None:
        payload = {
            "issue_key": "HACK-99",
            "issue_summary": "Malicious issue",
            "comment_body": "@openswe exploit this in evilorg/malrepo",
            "comment_author": "Mallory",
        }
        response = client_with_allowlist.post(
            "/webhooks/jira",
            json=payload,
            headers={"X-Jira-Webhook-Secret": _TEST_WEBHOOK_SECRET},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "ignored"
        assert "allowlist" in response.json()["reason"].lower()

    def test_default_repo_used_when_no_repo_in_comment(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When comment has no repo, DEFAULT_REPO_OWNER/NAME is used."""
        monkeypatch.setattr(webapp, "JIRA_WEBHOOK_SECRET", _TEST_WEBHOOK_SECRET)
        monkeypatch.setattr(webapp, "ALLOWED_GITHUB_ORGS", frozenset())  # No restriction
        monkeypatch.setattr(webapp, "DEFAULT_REPO_OWNER", "defaultowner")
        monkeypatch.setattr(webapp, "DEFAULT_REPO_NAME", "defaultrepo")

        client = TestClient(webapp.app)
        payload = {
            "issue_key": "PLAIN-1",
            "issue_summary": "Simple issue",
            "comment_body": "@openswe please take a look",  # No repo specified
            "comment_author": "Frank",
        }
        response = client.post(
            "/webhooks/jira",
            json=payload,
            headers={"X-Jira-Webhook-Secret": _TEST_WEBHOOK_SECRET},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "accepted"
        assert "defaultowner/defaultrepo" in data["message"]
