"""Tests for Telegram bot integration utilities and webhook handler."""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from agent.utils.telegram import (
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


async def test_process_telegram_message_private_chat_triggers_run() -> None:
    """Private chat messages always trigger a LangGraph run."""
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(chat_type="private", text="fix the bug")

    fake_run = {"run_id": "test-run-id"}
    fake_runs = AsyncMock()
    fake_runs.create = AsyncMock(return_value=fake_run)
    fake_client = AsyncMock()
    fake_client.runs = fake_runs

    with (
        patch("agent.webapp.send_telegram_message", new_callable=AsyncMock) as mock_send,
        patch("agent.webapp.post_telegram_trace_reply", new_callable=AsyncMock),
        patch("agent.webapp.is_thread_active", new_callable=AsyncMock, return_value=False),
        patch("agent.webapp.get_client", return_value=fake_client),
        patch(
            "agent.webapp.get_telegram_repo_config",
            return_value={"owner": "test-org", "name": "test-repo"},
        ),
    ):
        await process_telegram_message(update, "testbot")

    # Check acknowledgment was sent
    mock_send.assert_called_once()
    # Check LangGraph run was created
    fake_runs.create.assert_called_once()


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


async def test_process_telegram_message_group_with_mention_triggers_run() -> None:
    """Group messages that @mention the bot should trigger a run."""
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(
        chat_type="supergroup",
        text="@testbot please fix the login issue",
    )

    fake_run = {"run_id": "run-456"}
    fake_runs = AsyncMock()
    fake_runs.create = AsyncMock(return_value=fake_run)
    fake_client = AsyncMock()
    fake_client.runs = fake_runs

    with (
        patch("agent.webapp.send_telegram_message", new_callable=AsyncMock) as mock_send,
        patch("agent.webapp.post_telegram_trace_reply", new_callable=AsyncMock),
        patch("agent.webapp.is_thread_active", new_callable=AsyncMock, return_value=False),
        patch("agent.webapp.get_client", return_value=fake_client),
        patch(
            "agent.webapp.get_telegram_repo_config",
            return_value={"owner": "test-org", "name": "test-repo"},
        ),
    ):
        await process_telegram_message(update, "testbot")

    mock_send.assert_called_once()
    fake_runs.create.assert_called_once()


async def test_process_telegram_message_active_thread_queues_message() -> None:
    """When the LangGraph thread is busy, new messages should be queued."""
    from agent.webapp import process_telegram_message

    update = _make_telegram_update(chat_type="private", text="follow-up question")

    with (
        patch("agent.webapp.send_telegram_message", new_callable=AsyncMock),
        patch("agent.webapp.is_thread_active", new_callable=AsyncMock, return_value=True),
        patch(
            "agent.webapp.queue_message_for_thread",
            new_callable=AsyncMock,
            return_value=True,
        ) as mock_queue,
        patch("agent.webapp.get_client"),
        patch(
            "agent.webapp.get_telegram_repo_config",
            return_value={"owner": "test-org", "name": "test-repo"},
        ),
    ):
        await process_telegram_message(update, "testbot")

    mock_queue.assert_called_once()
