from __future__ import annotations

from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from agent import webapp


class _FakeNotFoundError(Exception):
    status_code = 404


class _FakeThreadsClient:
    def __init__(self, thread: dict | None = None, raise_not_found: bool = False) -> None:
        self.thread = thread
        self.raise_not_found = raise_not_found
        self.updated_metadata: list[dict] = []
        self.created_metadata: list[dict] = []

    async def get(self, thread_id: str) -> dict:
        if self.raise_not_found:
            raise _FakeNotFoundError("not found")
        return self.thread or {"metadata": {}}

    async def update(self, thread_id: str, metadata: dict) -> None:
        if self.raise_not_found:
            raise _FakeNotFoundError("not found")
        self.updated_metadata.append(metadata)

    async def create(self, thread_id: str, if_exists: str, metadata: dict) -> None:
        self.created_metadata.append(metadata)


class _FakeClient:
    def __init__(self, threads_client: _FakeThreadsClient) -> None:
        self.threads = threads_client


def _build_payload(text: str) -> dict:
    return {
        "type": "event_callback",
        "event": {
            "type": "app_mention",
            "channel": "C123",
            "ts": "1710000000.100000",
            "thread_ts": "1710000000.100000",
            "user": "U123",
            "text": text,
        },
    }


def test_slack_webhook_requests_repo_branch_confirmation(
    monkeypatch,
) -> None:
    threads_client = _FakeThreadsClient(raise_not_found=True)
    fake_post = AsyncMock(return_value=True)
    fake_process = AsyncMock()

    monkeypatch.setattr(webapp, "verify_slack_signature", lambda **kwargs: True)
    monkeypatch.setattr(webapp, "get_client", lambda url: _FakeClient(threads_client))
    monkeypatch.setattr(webapp, "post_slack_thread_reply", fake_post)
    monkeypatch.setattr(webapp, "process_slack_mention", fake_process)

    client = TestClient(webapp.app)
    response = client.post(
        "/webhooks/slack",
        json=_build_payload("<@UBOT> please fix this bug"),
        headers={
            "X-Slack-Signature": "v0=test",
            "X-Slack-Request-Timestamp": "1710000000",
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    assert response.json()["message"] == "Slack repo/branch confirmation requested"
    fake_process.assert_not_called()
    fake_post.assert_awaited_once()
    assert "Before I start working" in fake_post.await_args.args[2]
    assert threads_client.created_metadata == [
        {
            "repo": {"owner": "langchain-ai", "name": "langchainplus"},
            "base_branch": "",
            "branch_name": "",
            "repo_branch_confirmation": {
                "awaiting": True,
                "source": "slack",
                "repo": {"owner": "langchain-ai", "name": "langchainplus"},
                "base_branch": "",
                "branch_name": "",
                "request": {
                    "event_data": {
                        "channel_id": "C123",
                        "thread_ts": "1710000000.100000",
                        "event_ts": "1710000000.100000",
                        "user_id": "U123",
                        "text": "<@UBOT> please fix this bug",
                        "bot_user_id": "",
                    }
                },
            },
        }
    ]


def test_slack_webhook_affirmative_confirmation_starts_saved_request(
    monkeypatch,
) -> None:
    threads_client = _FakeThreadsClient(
        thread={
            "metadata": {
                "repo": {"owner": "saved-org", "name": "saved-repo"},
                "repo_branch_confirmation": {
                    "awaiting": True,
                    "source": "slack",
                    "repo": {"owner": "next-org", "name": "next-repo"},
                    "base_branch": "main",
                    "branch_name": "feature/next",
                    "request": {
                        "event_data": {
                            "channel_id": "C123",
                            "thread_ts": "1710000000.100000",
                            "event_ts": "1710000000.100000",
                            "user_id": "U123",
                            "text": "<@UBOT> please fix this bug",
                            "bot_user_id": "UBOT",
                        }
                    },
                },
            }
        }
    )
    fake_post = AsyncMock(return_value=True)
    fake_process = AsyncMock()

    monkeypatch.setattr(webapp, "verify_slack_signature", lambda **kwargs: True)
    monkeypatch.setattr(webapp, "get_client", lambda url: _FakeClient(threads_client))
    monkeypatch.setattr(webapp, "post_slack_thread_reply", fake_post)
    monkeypatch.setattr(webapp, "process_slack_mention", fake_process)
    monkeypatch.setattr(webapp, "SLACK_BOT_USER_ID", "UBOT")

    client = TestClient(webapp.app)
    response = client.post(
        "/webhooks/slack",
        json=_build_payload("<@UBOT> yes"),
        headers={
            "X-Slack-Signature": "v0=test",
            "X-Slack-Request-Timestamp": "1710000000",
        },
    )

    assert response.status_code == 200
    assert response.json()["message"] == "Slack confirmation received; processing queued task"
    fake_post.assert_not_called()
    fake_process.assert_awaited_once()
    process_args = fake_process.await_args.args
    assert process_args[0]["text"] == "<@UBOT> please fix this bug"
    assert process_args[1] == {"owner": "next-org", "name": "next-repo"}
    assert fake_process.await_args.kwargs["base_branch"] == "main"
    assert fake_process.await_args.kwargs["branch_name"] == "feature/next"
    assert threads_client.updated_metadata[0] == {
        "repo": {"owner": "next-org", "name": "next-repo"},
        "base_branch": "main",
        "branch_name": "feature/next",
        "repo_branch_confirmation": {},
    }
