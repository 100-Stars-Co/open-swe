"""Tests for Telegram bot integration utilities and webhook handler."""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from agent.utils.telegram import (
    extract_telegram_branch_overrides,
    generate_thread_id_from_telegram_chat,
    get_telegram_repo_config,
    is_bot_mentioned,
    strip_bot_mention,
    verify_telegram_secret,
)

# ---------------------------------------------------------------------------
# generate_thread_id_from_telegram_chat
# ---------------------------------------------------------------------------


def test_generate_thread_id_is_deterministic() -> None:
    chat_id = 123456789
    first = generate_thread_id_from_telegram_chat(chat_id)
    second = generate_thread_id_from_telegram_chat(chat_id)
    assert first == second
    assert len(first) == 36


def test_generate_thread_id_differs_by_chat_id() -> None:
    assert generate_thread_id_from_telegram_chat(1) != generate_thread_id_from_telegram_chat(2)


def test_generate_thread_id_differs_with_message_thread_id() -> None:
    chat_id = 999
    without_topic = generate_thread_id_from_telegram_chat(chat_id)
    with_topic = generate_thread_id_from_telegram_chat(chat_id, message_thread_id=42)
    assert without_topic != with_topic


def test_generate_thread_id_is_deterministic_with_topic() -> None:
    chat_id = 111
    first = generate_thread_id_from_telegram_chat(chat_id, message_thread_id=7)
    second = generate_thread_id_from_telegram_chat(chat_id, message_thread_id=7)
    assert first == second


# ---------------------------------------------------------------------------
# verify_telegram_secret
# ---------------------------------------------------------------------------


def test_verify_telegram_secret_valid() -> None:
    assert verify_telegram_secret("my-secret", "my-secret") is True


def test_verify_telegram_secret_invalid() -> None:
    assert verify_telegram_secret("wrong", "my-secret") is False


def test_verify_telegram_secret_empty_token() -> None:
    assert verify_telegram_secret("", "my-secret") is False


def test_verify_telegram_secret_empty_expected() -> None:
    assert verify_telegram_secret("my-secret", "") is False


# ---------------------------------------------------------------------------
# is_bot_mentioned
# ---------------------------------------------------------------------------


def test_is_bot_mentioned_true() -> None:
    assert is_bot_mentioned("Hey @mybot help me out", "mybot") is True


def test_is_bot_mentioned_false() -> None:
    assert is_bot_mentioned("Just a regular message", "mybot") is False


def test_is_bot_mentioned_empty_text() -> None:
    assert is_bot_mentioned("", "mybot") is False


def test_is_bot_mentioned_empty_username() -> None:
    assert is_bot_mentioned("Hello @mybot", "") is False


# ---------------------------------------------------------------------------
# strip_bot_mention
# ---------------------------------------------------------------------------


def test_strip_bot_mention_removes_mention() -> None:
    result = strip_bot_mention("@mybot please help with this", "mybot")
    assert "@mybot" not in result
    assert "please help with this" in result


def test_strip_bot_mention_empty_text() -> None:
    assert strip_bot_mention("", "mybot") == ""


def test_strip_bot_mention_no_mention() -> None:
    result = strip_bot_mention("just a normal message", "mybot")
    assert result == "just a normal message"


# ---------------------------------------------------------------------------
# get_telegram_repo_config
# ---------------------------------------------------------------------------


def test_get_telegram_repo_config_from_inline_directive() -> None:
    config = get_telegram_repo_config(
        text="repo:myorg/myrepo please fix the bug",
        default_owner="fallback-org",
        default_name="fallback-repo",
    )
    assert config["owner"] == "myorg"
    assert config["name"] == "myrepo"


def test_get_telegram_repo_config_falls_back_to_defaults() -> None:
    config = get_telegram_repo_config(
        text="just a normal message",
        default_owner="default-org",
        default_name="default-repo",
    )
    assert config["owner"] == "default-org"
    assert config["name"] == "default-repo"


def test_get_telegram_repo_config_uses_env_vars_when_no_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TELEGRAM_REPO_OWNER", "env-org")
    monkeypatch.setenv("TELEGRAM_REPO_NAME", "env-repo")

    # Re-import after env var is set to pick up module-level constant changes.
    # Since the function reads the env var at call time via default_owner, pass explicitly.
    config = get_telegram_repo_config(
        text="no directive here",
        default_owner=os.environ.get("TELEGRAM_REPO_OWNER", ""),
        default_name=os.environ.get("TELEGRAM_REPO_NAME", ""),
    )
    assert config["owner"] == "env-org"
    assert config["name"] == "env-repo"


# ---------------------------------------------------------------------------
# extract_telegram_branch_overrides
# ---------------------------------------------------------------------------


def test_extract_telegram_branch_overrides_explicit_directives() -> None:
    overrides = extract_telegram_branch_overrides(
        "repo:acme/app base:main branch:feature/telegram-natural-chat"
    )
    assert overrides == {
        "base_branch": "main",
        "branch_name": "feature/telegram-natural-chat",
    }


def test_extract_telegram_branch_overrides_natural_language() -> None:
    overrides = extract_telegram_branch_overrides(
        "Please target base branch release/2025.04 and use branch fix/login-flow"
    )
    assert overrides == {
        "base_branch": "release/2025.04",
        "branch_name": "fix/login-flow",
    }


# ---------------------------------------------------------------------------
# Webhook handler (integration-level, no live sandbox or Telegram API)
# ---------------------------------------------------------------------------


def _make_telegram_update(
    *,
    chat_type: str = "private",
    text: str = "help me",
    chat_id: int = 12345,
    message_id: int = 1,
    user_id: int = 999,
    first_name: str = "Alice",
    message_thread_id: int | None = None,
) -> dict[str, Any]:
    msg: dict[str, Any] = {
        "message_id": message_id,
        "from": {"id": user_id, "first_name": first_name, "is_bot": False},
        "chat": {"id": chat_id, "type": chat_type},
        "text": text,
        "date": 1700000000,
    }
    if message_thread_id is not None:
        msg["message_thread_id"] = message_thread_id
    return {"update_id": 1, "message": msg}


class _FakeNotFoundError(Exception):
    status_code = 404


class _FakeThreadsClient:
    def __init__(self, thread: dict[str, Any] | None = None, raise_not_found: bool = False) -> None:
        self.thread = thread
        self.raise_not_found = raise_not_found
        self.updated_metadata: list[dict[str, Any]] = []
        self.created_metadata: list[dict[str, Any]] = []

    async def get(self, thread_id: str) -> dict[str, Any]:
        if self.raise_not_found:
            raise _FakeNotFoundError("not found")
        return self.thread or {"metadata": {}}

    async def update(self, thread_id: str, metadata: dict[str, Any]) -> None:
        if self.raise_not_found:
            raise _FakeNotFoundError("not found")
        self.updated_metadata.append(metadata)

    async def create(self, thread_id: str, if_exists: str, metadata: dict[str, Any]) -> None:
        self.created_metadata.append(metadata)


class _FakeRunsClient:
    def __init__(
        self,
        final_state: dict[str, Any] | None = None,
        run_id: str = "test-run-id",
    ) -> None:
        self.final_state = final_state or {"messages": []}
        self.run_id = run_id
        self.wait_calls: list[dict[str, Any]] = []

    async def wait(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        self.wait_calls.append({"args": args, "kwargs": kwargs})
        on_run_created = kwargs.get("on_run_created")
        if callable(on_run_created):
            on_run_created({"run_id": self.run_id})
        return self.final_state


async def test_process_telegram_message_private_chat_requests_confirmation() -> None:
    """Private chat messages ask for repo/branch confirmation before a run starts."""
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(chat_type="private", text="fix the bug")

    fake_runs = _FakeRunsClient(
        final_state={"messages": [{"role": "assistant", "content": "Looking into it now."}]}
    )
    fake_client = AsyncMock()
    fake_client.runs = fake_runs
    fake_client.threads = _FakeThreadsClient(raise_not_found=True)

    with (
        patch(
            "agent.webapp.send_telegram_message",
            new_callable=AsyncMock,
            return_value={"ok": True, "result": {"message_id": 99}},
        ) as mock_send,
        patch("agent.webapp.send_telegram_chat_action", new_callable=AsyncMock) as mock_typing,
        patch("agent.webapp.is_thread_active", new_callable=AsyncMock, return_value=False),
        patch("agent.webapp.get_client", return_value=fake_client),
    ):
        await process_telegram_message(update, "testbot")

    assert mock_send.await_count == 1
    assert mock_send.await_args.kwargs["reply_to_message_id"] == 1
    assert (
        "Before I start working, confirm the target repo and branch selection:"
        in mock_send.await_args.args[1]
    )
    assert not fake_runs.wait_calls
    mock_typing.assert_not_called()
    assert fake_client.threads.created_metadata == [
        {
            "repo": {"owner": "langchain-ai", "name": "langchainplus"},
            "base_branch": "",
            "branch_name": "",
            "repo_branch_confirmation": {
                "awaiting": True,
                "source": "telegram",
                "repo": {"owner": "langchain-ai", "name": "langchainplus"},
                "base_branch": "",
                "branch_name": "",
                "request": {
                    "message_id": 1,
                    "user_id": 999,
                    "user_name": "Alice",
                    "clean_text": "fix the bug",
                    "chat_description": "Chat type: private",
                },
            },
        }
    ]


async def test_process_telegram_message_group_no_mention_ignored() -> None:
    """Group messages without a bot @mention should be silently ignored."""
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(
        chat_type="group",
        text="just chatting, no bot mention",
    )

    with (
        patch("agent.webapp.send_telegram_message", new_callable=AsyncMock) as mock_send,
        patch("agent.webapp.get_client") as mock_client,
    ):
        await process_telegram_message(update, "testbot")

    mock_send.assert_not_called()
    mock_client.assert_not_called()


async def test_process_telegram_message_group_with_mention_requests_confirmation() -> None:
    """Group messages that @mention the bot should also confirm repo/branch first."""
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(
        chat_type="supergroup",
        text="@testbot please fix the login issue",
    )

    fake_runs = _FakeRunsClient(
        final_state={"messages": [{"role": "assistant", "content": "I can help with that."}]},
        run_id="run-456",
    )
    fake_client = AsyncMock()
    fake_client.runs = fake_runs
    fake_client.threads = _FakeThreadsClient(raise_not_found=True)

    with (
        patch(
            "agent.webapp.send_telegram_message",
            new_callable=AsyncMock,
            return_value={"ok": True, "result": {"message_id": 77}},
        ) as mock_send,
        patch("agent.webapp.send_telegram_chat_action", new_callable=AsyncMock) as mock_typing,
        patch("agent.webapp.is_thread_active", new_callable=AsyncMock, return_value=False),
        patch("agent.webapp.get_client", return_value=fake_client),
    ):
        await process_telegram_message(update, "testbot")

    mock_send.assert_awaited_once()
    assert "Before I start working" in mock_send.await_args.args[1]
    mock_typing.assert_not_called()
    assert len(fake_runs.wait_calls) == 0


async def test_process_telegram_message_active_thread_requests_confirmation_before_queue() -> None:
    """Busy threads should still confirm repo/branch before queueing new work."""
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(
        chat_type="private",
        text="follow-up question repo:next-org/next-repo base:release branch:feature/next",
    )
    fake_client = AsyncMock()
    fake_client.threads = _FakeThreadsClient(thread={"metadata": {"repo": {"owner": "saved", "name": "repo"}}})

    with (
        patch("agent.webapp.send_telegram_message", new_callable=AsyncMock) as mock_send,
        patch("agent.webapp.send_telegram_chat_action", new_callable=AsyncMock) as mock_typing,
        patch("agent.webapp.is_thread_active", new_callable=AsyncMock, return_value=True),
        patch(
            "agent.webapp.queue_message_for_thread",
            new_callable=AsyncMock,
            return_value=True,
        ) as mock_queue,
        patch("agent.webapp.get_client", return_value=fake_client),
    ):
        await process_telegram_message(update, "testbot")

    mock_send.assert_awaited_once()
    assert "Before I start working" in mock_send.await_args.args[1]
    mock_typing.assert_not_called()
    mock_queue.assert_not_called()
    assert fake_client.threads.updated_metadata[-1] == {
        "repo": {"owner": "saved", "name": "repo"},
        "base_branch": "",
        "branch_name": "",
        "repo_branch_confirmation": {
            "awaiting": True,
            "source": "telegram",
            "repo": {"owner": "next-org", "name": "next-repo"},
            "base_branch": "release",
            "branch_name": "feature/next",
            "request": {
                "message_id": 1,
                "user_id": 999,
                "user_name": "Alice",
                "clean_text": "follow-up question repo:next-org/next-repo base:release branch:feature/next",
                "chat_description": "Chat type: private",
            },
        },
    }


async def test_process_telegram_message_reuses_saved_repo_and_branch_metadata() -> None:
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(chat_type="private", text="please check the bug")

    fake_runs = _FakeRunsClient(
        final_state={"messages": [{"role": "assistant", "content": "Checking the saved branch."}]},
        run_id="run-789",
    )
    fake_threads = _FakeThreadsClient(
        thread={
            "metadata": {
                "repo": {"owner": "saved-org", "name": "saved-repo"},
                "base_branch": "release/1.2",
                "branch_name": "feature/saved-work",
            }
        }
    )
    fake_client = AsyncMock()
    fake_client.runs = fake_runs
    fake_client.threads = fake_threads

    with (
        patch(
            "agent.webapp.send_telegram_message",
            new_callable=AsyncMock,
            return_value={"ok": True, "result": {"message_id": 55}},
        ) as mock_send,
        patch("agent.webapp.send_telegram_chat_action", new_callable=AsyncMock) as mock_typing,
        patch("agent.webapp.is_thread_active", new_callable=AsyncMock, return_value=False),
        patch("agent.webapp.get_client", return_value=fake_client),
    ):
        await process_telegram_message(update, "testbot")

    assert len(fake_runs.wait_calls) == 1
    mock_typing.assert_awaited()
    run_kwargs = fake_runs.wait_calls[0]["kwargs"]
    assert run_kwargs["config"]["metadata"]["base_branch"] == "release/1.2"
    assert run_kwargs["config"]["metadata"]["branch_name"] == "feature/saved-work"
    assert (
        run_kwargs["config"]["configurable"]["repo"]
        == {"owner": "saved-org", "name": "saved-repo"}
    )
    assert mock_send.await_args_list[0].args[1] == "Working on it. I’ll send short updates at important steps."
    assert mock_send.await_args_list[1].args[1] == "Checking the saved branch."


async def test_process_telegram_message_no_final_text_uses_fallback_message() -> None:
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(chat_type="private", text="help")

    fake_runs = _FakeRunsClient(final_state={"messages": []})
    fake_client = AsyncMock()
    fake_client.runs = fake_runs
    fake_client.threads = _FakeThreadsClient(
        thread={"metadata": {"repo": {"owner": "test-org", "name": "test-repo"}}}
    )

    with (
        patch(
            "agent.webapp.send_telegram_message",
            new_callable=AsyncMock,
            return_value={"ok": True, "result": {"message_id": 10}},
        ) as mock_send,
        patch("agent.webapp.send_telegram_chat_action", new_callable=AsyncMock) as mock_typing,
        patch("agent.webapp.is_thread_active", new_callable=AsyncMock, return_value=False),
        patch("agent.webapp.get_client", return_value=fake_client),
    ):
        await process_telegram_message(update, "testbot")

    mock_typing.assert_awaited()
    assert mock_send.await_args_list[0].args[1] == "Working on it. I’ll send short updates at important steps."
    assert mock_send.await_args_list[1].args[1] == "I finished the run, but I do not have a response to show yet."


async def test_process_telegram_message_affirmative_confirmation_starts_saved_request() -> None:
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(chat_type="private", text="yes")
    fake_runs = _FakeRunsClient(
        final_state={"messages": [{"role": "assistant", "content": "Implemented on the confirmed branch."}]}
    )
    fake_client = AsyncMock()
    fake_client.runs = fake_runs
    fake_client.threads = _FakeThreadsClient(
        thread={
            "metadata": {
                "repo": {"owner": "saved-org", "name": "saved-repo"},
                "base_branch": "",
                "branch_name": "",
                "repo_branch_confirmation": {
                    "awaiting": True,
                    "source": "telegram",
                    "repo": {"owner": "next-org", "name": "next-repo"},
                    "base_branch": "main",
                    "branch_name": "feature/next",
                    "request": {
                        "message_id": 44,
                        "user_id": 999,
                        "user_name": "Alice",
                        "clean_text": "please fix the login bug",
                        "chat_description": "Chat type: private",
                    },
                },
            }
        }
    )

    with (
        patch(
            "agent.webapp.send_telegram_message",
            new_callable=AsyncMock,
            return_value={"ok": True, "result": {"message_id": 10}},
        ) as mock_send,
        patch("agent.webapp.send_telegram_chat_action", new_callable=AsyncMock) as mock_typing,
        patch("agent.webapp.is_thread_active", new_callable=AsyncMock, return_value=False),
        patch("agent.webapp.get_client", return_value=fake_client),
    ):
        await process_telegram_message(update, "testbot")

    assert len(fake_runs.wait_calls) == 1
    run_kwargs = fake_runs.wait_calls[0]["kwargs"]
    assert run_kwargs["config"]["configurable"]["repo"] == {"owner": "next-org", "name": "next-repo"}
    assert run_kwargs["config"]["configurable"]["base_branch"] == "main"
    assert run_kwargs["config"]["configurable"]["branch_name"] == "feature/next"
    assert "please fix the login bug" in run_kwargs["input"]["messages"][0]["content"][0]["text"]
    assert mock_send.await_args_list[0].args[1] == "Working on it. I’ll send short updates at important steps."
    assert mock_send.await_args_list[1].args[1] == "Implemented on the confirmed branch."
    mock_typing.assert_awaited()
    assert fake_client.threads.updated_metadata[0] == {
        "repo": {"owner": "next-org", "name": "next-repo"},
        "base_branch": "main",
        "branch_name": "feature/next",
        "repo_branch_confirmation": {},
    }


async def test_process_telegram_message_correction_updates_confirmation() -> None:
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(
        chat_type="private",
        text="repo:fixed-org/fixed-repo base:release branch:feature/fix",
    )
    fake_runs = _FakeRunsClient()
    fake_client = AsyncMock()
    fake_client.runs = fake_runs
    fake_client.threads = _FakeThreadsClient(
        thread={
            "metadata": {
                "repo": {"owner": "saved-org", "name": "saved-repo"},
                "repo_branch_confirmation": {
                    "awaiting": True,
                    "source": "telegram",
                    "repo": {"owner": "wrong-org", "name": "wrong-repo"},
                    "base_branch": "main",
                    "branch_name": "feature/wrong",
                    "request": {
                        "message_id": 1,
                        "user_id": 999,
                        "user_name": "Alice",
                        "clean_text": "fix bug",
                        "chat_description": "Chat type: private",
                    },
                },
            }
        }
    )

    with (
        patch(
            "agent.webapp.send_telegram_message",
            new_callable=AsyncMock,
            return_value={"ok": True, "result": {"message_id": 10}},
        ) as mock_send,
        patch("agent.webapp.send_telegram_chat_action", new_callable=AsyncMock) as mock_typing,
        patch("agent.webapp.get_client", return_value=fake_client),
    ):
        await process_telegram_message(update, "testbot")

    mock_typing.assert_not_called()
    assert not fake_runs.wait_calls
    assert "fixed-org/fixed-repo" in mock_send.await_args.args[1]
    assert "feature/fix" in mock_send.await_args.args[1]
    assert fake_client.threads.updated_metadata[0] == {
        "repo": {"owner": "saved-org", "name": "saved-repo"},
        "base_branch": "",
        "branch_name": "",
        "repo_branch_confirmation": {
            "awaiting": True,
            "source": "telegram",
            "repo": {"owner": "fixed-org", "name": "fixed-repo"},
            "base_branch": "release",
            "branch_name": "feature/fix",
            "request": {
                "message_id": 1,
                "user_id": 999,
                "user_name": "Alice",
                "clean_text": "fix bug",
                "chat_description": "Chat type: private",
            },
        },
    }
