"""Telegram Bot API utilities."""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import uuid
from typing import Any

import httpx

from agent.utils.tracing import get_trace_url

logger = logging.getLogger(__name__)

TELEGRAM_API_BASE_URL = "https://api.telegram.org"
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_REPO_OWNER = os.environ.get("TELEGRAM_REPO_OWNER", "")
TELEGRAM_REPO_NAME = os.environ.get("TELEGRAM_REPO_NAME", "")


def _telegram_api_url(method: str) -> str:
    if not TELEGRAM_BOT_TOKEN:
        raise ValueError("TELEGRAM_BOT_TOKEN environment variable is not set")
    return f"{TELEGRAM_API_BASE_URL}/bot{TELEGRAM_BOT_TOKEN}/{method}"


def verify_telegram_secret(token: str, expected_secret: str) -> bool:
    """Verify the X-Telegram-Bot-Api-Secret-Token header.

    Telegram sends this header verbatim (no HMAC), so we do a constant-time
    string comparison to avoid timing attacks.

    Args:
        token: Value from the X-Telegram-Bot-Api-Secret-Token request header.
        expected_secret: TELEGRAM_WEBHOOK_SECRET env var value.

    Returns:
        True if the token matches, False otherwise.
    """
    if not expected_secret:
        logger.warning("TELEGRAM_WEBHOOK_SECRET is not configured — rejecting webhook request")
        return False
    if not token:
        return False
    return hmac.compare_digest(token.encode(), expected_secret.encode())


def generate_thread_id_from_telegram_chat(
    chat_id: int, message_thread_id: int | None = None
) -> str:
    """Generate a deterministic LangGraph thread ID from a Telegram chat.

    For standard chats, uses chat_id alone.
    For forum group topics, uses chat_id + message_thread_id so each topic
    maps to its own LangGraph thread.

    Args:
        chat_id: Telegram chat identifier.
        message_thread_id: Message thread ID for forum topics (optional).

    Returns:
        A 36-character UUID string.
    """
    if message_thread_id is not None:
        composite = f"telegram:{chat_id}:{message_thread_id}"
    else:
        composite = f"telegram:{chat_id}"
    md5_hex = hashlib.md5(composite.encode("utf-8")).hexdigest()  # noqa: S324
    return str(uuid.UUID(hex=md5_hex))


async def send_telegram_message(
    chat_id: int,
    text: str,
    *,
    reply_to_message_id: int | None = None,
    message_thread_id: int | None = None,
    parse_mode: str = "HTML",
) -> dict[str, Any]:
    """Send a message to a Telegram chat.

    Args:
        chat_id: Target Telegram chat ID.
        text: Message text (HTML formatted by default).
        reply_to_message_id: Optional message ID to reply to.
        message_thread_id: Forum topic thread ID (for supergroup forums).
        parse_mode: Telegram parse mode. Defaults to "HTML".

    Returns:
        The Telegram API response dict.
    """
    if not TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN is not set — cannot send Telegram message")
        return {"ok": False, "error": "TELEGRAM_BOT_TOKEN not configured"}

    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
    }
    if reply_to_message_id is not None:
        payload["reply_to_message_id"] = reply_to_message_id
    if message_thread_id is not None:
        payload["message_thread_id"] = message_thread_id

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(_telegram_api_url("sendMessage"), json=payload)
            data = response.json()
            if not data.get("ok"):
                logger.warning(
                    "Telegram sendMessage failed: %s", data.get("description", "unknown error")
                )
            return data
    except Exception:
        logger.exception("Error sending Telegram message to chat %s", chat_id)
        return {"ok": False, "error": "Request failed"}


def strip_bot_mention(text: str, bot_username: str) -> str:
    """Remove the @bot_username mention from text.

    Args:
        text: The raw message text.
        bot_username: The bot's username (without @).

    Returns:
        Cleaned text with the bot mention removed.
    """
    if not text:
        return ""
    stripped = text
    if bot_username:
        stripped = stripped.replace(f"@{bot_username}", "")
    return stripped.strip()


def is_bot_mentioned(text: str, bot_username: str) -> bool:
    """Check if the bot is @mentioned in a message.

    Args:
        text: Message text.
        bot_username: Bot username (without @).

    Returns:
        True if the bot is mentioned in the text.
    """
    if not text or not bot_username:
        return False
    return f"@{bot_username}" in text


def get_telegram_repo_config(
    text: str | None = None,
    default_owner: str = "",
    default_name: str = "",
) -> dict[str, str]:
    """Resolve repository configuration from Telegram message text.

    Searches the message for an inline ``repo:owner/name`` or
    ``repo owner/name`` directive. Falls back to the supplied defaults,
    and ultimately to the TELEGRAM_REPO_OWNER/TELEGRAM_REPO_NAME env vars.

    Args:
        text: The Telegram message text.
        default_owner: Fallback owner if not found in text.
        default_name: Fallback repo name if not found in text.

    Returns:
        Dict with "owner" and "name" keys.
    """
    from .repo import extract_repo_from_text  # local import to avoid circular deps

    owner_default = default_owner or TELEGRAM_REPO_OWNER
    name_default = default_name or TELEGRAM_REPO_NAME

    repo_config: dict[str, str] | None = None
    if text:
        repo_config = extract_repo_from_text(text, default_owner=owner_default)

    if not repo_config:
        repo_config = {"owner": owner_default, "name": name_default}

    return repo_config


async def post_telegram_trace_reply(
    chat_id: int, run_id: str, *, message_thread_id: int | None = None
) -> None:
    """Post a trace URL reply to a Telegram chat for observability.

    Args:
        chat_id: Target Telegram chat ID.
        run_id: LangGraph run ID for building the trace URL.
        message_thread_id: Forum topic thread ID (optional).
    """
    trace_url = get_trace_url(run_id)
    if not trace_url:
        return
    await send_telegram_message(
        chat_id,
        f"🔍 Trace: {trace_url}",
        message_thread_id=message_thread_id,
    )
