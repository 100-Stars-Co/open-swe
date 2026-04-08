"""Custom FastAPI routes for LangGraph server."""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import uuid
from typing import Any

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from langchain_core.messages.content import create_text_block
from langgraph_sdk import get_client
from langgraph_sdk.client import LangGraphClient

from .utils.auth import (
    persist_encrypted_github_token,
)
from .utils.comments import get_recent_comments
from .utils.extract import extract_base_branch_with_llm
from .utils.github_app import get_github_app_installation_token
from .utils.github_comments import (
    OPEN_SWE_TAGS,
    build_pr_prompt,
    extract_pr_context,
    fetch_issue_comments,
    fetch_pr_comments_since_last_tag,
    format_github_comment_body_for_prompt,
    get_thread_id_from_branch,
    react_to_github_comment,
    sanitize_github_comment_body,
    verify_github_signature,
)
from .utils.github_user_email_map import GITHUB_USER_EMAIL_MAP
from .utils.jira import add_comment as jira_add_comment
from .utils.jira import get_issue as jira_get_issue
from .utils.jira_webhook import (
    contains_bot_mention as jira_contains_bot_mention,
)
from .utils.jira_webhook import (
    extract_repo_from_text as jira_extract_repo_from_text,
)
from .utils.jira_webhook import (
    generate_thread_id_from_jira_issue,
    parse_jira_webhook_payload,
    verify_jira_webhook_secret,
)
from .utils.linear import post_linear_trace_comment
from .utils.linear_team_repo_map import LINEAR_TEAM_TO_REPO
from .utils.multimodal import dedupe_urls, extract_image_urls, fetch_image_block
from .utils.messages import extract_text_content
from .utils.repo import extract_repo_from_text
from .utils.slack import (
    add_slack_reaction,
    fetch_slack_thread_messages,
    format_slack_messages_for_prompt,
    get_slack_user_info,
    get_slack_user_names,
    post_slack_thread_reply,
    post_slack_trace_reply,
    select_slack_context_messages,
    strip_bot_mention,
    verify_slack_signature,
)
from .utils.telegram import (
    extract_telegram_branch_overrides,
    generate_thread_id_from_telegram_chat,
    get_telegram_repo_config,
    is_bot_mentioned,
    send_telegram_chat_action,
    send_telegram_message,
    verify_telegram_secret,
)
from .utils.telegram import (
    strip_bot_mention as telegram_strip_bot_mention,
)
from .utils.tracing import get_trace_url

logger = logging.getLogger(__name__)

app = FastAPI()

LINEAR_WEBHOOK_SECRET = os.environ.get("LINEAR_WEBHOOK_SECRET", "")
GITHUB_WEBHOOK_SECRET = os.environ.get("GITHUB_WEBHOOK_SECRET", "")
SLACK_SIGNING_SECRET = os.environ.get("SLACK_SIGNING_SECRET", "")
JIRA_WEBHOOK_SECRET = os.environ.get("JIRA_WEBHOOK_SECRET", "")
SLACK_BOT_USER_ID = os.environ.get("SLACK_BOT_USER_ID", "")
SLACK_BOT_USERNAME = os.environ.get("SLACK_BOT_USERNAME", "")
DEFAULT_REPO_OWNER = os.environ.get("DEFAULT_REPO_OWNER", "langchain-ai")
DEFAULT_REPO_NAME = os.environ.get("DEFAULT_REPO_NAME", "langchainplus")
SLACK_REPO_OWNER = os.environ.get("SLACK_REPO_OWNER", "") or DEFAULT_REPO_OWNER
SLACK_REPO_NAME = os.environ.get("SLACK_REPO_NAME", "") or DEFAULT_REPO_NAME
TELEGRAM_WEBHOOK_SECRET = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
TELEGRAM_BOT_USERNAME = os.environ.get("TELEGRAM_BOT_USERNAME", "")

LANGGRAPH_URL = os.environ.get("LANGGRAPH_URL") or os.environ.get(
    "LANGGRAPH_URL_PROD", "http://localhost:2024"
)

_AGENT_VERSION_METADATA: dict[str, str] = (
    {"AGENT_VERSION": os.environ["LANGCHAIN_REVISION_ID"]}
    if os.environ.get("LANGCHAIN_REVISION_ID")
    else {}
)

ALLOWED_GITHUB_ORGS: frozenset[str] = frozenset(
    org.strip().lower()
    for org in os.environ.get("ALLOWED_GITHUB_ORGS", "").split(",")
    if org.strip()
)

_REPO_BRANCH_CONFIRMATION_KEY = "repo_branch_confirmation"

LINEAR_API_KEY = os.environ.get("LINEAR_API_KEY", "")

_GITHUB_BOT_MESSAGE_PREFIXES = (
    "🔐 **GitHub Authentication Required**",
    "✅ **Pull Request Created**",
    "✅ **Pull Request Updated**",
    "**Pull Request Created**",
    "**Pull Request Updated**",
    "🤖 **Agent Response**",
    "❌ **Agent Error**",
)


def get_repo_config_from_team_mapping(
    team_identifier: str, project_name: str = ""
) -> dict[str, str]:
    """Look up repository configuration from LINEAR_TEAM_TO_REPO mapping."""
    fallback = {"owner": DEFAULT_REPO_OWNER, "name": DEFAULT_REPO_NAME}

    if not team_identifier or team_identifier not in LINEAR_TEAM_TO_REPO:
        return fallback

    config = LINEAR_TEAM_TO_REPO[team_identifier]

    if "owner" in config and "name" in config:
        return config

    if "projects" in config and project_name:
        project_config = config["projects"].get(project_name)
        if project_config:
            return project_config

    if "default" in config:
        return config["default"]

    return fallback


async def react_to_linear_comment(comment_id: str, emoji: str = "👀") -> bool:
    """Add an emoji reaction to a Linear comment.

    Args:
        comment_id: The Linear comment ID
        emoji: The emoji to react with (default: eyes 👀)

    Returns:
        True if successful, False otherwise
    """
    if not LINEAR_API_KEY:
        return False

    url = "https://api.linear.app/graphql"

    mutation = """
    mutation ReactionCreate($commentId: String!, $emoji: String!) {
        reactionCreate(input: { commentId: $commentId, emoji: $emoji }) {
            success
        }
    }
    """

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                url,
                headers={
                    "Authorization": LINEAR_API_KEY,
                    "Content-Type": "application/json",
                },
                json={
                    "query": mutation,
                    "variables": {"commentId": comment_id, "emoji": emoji},
                },
            )
            response.raise_for_status()
            result = response.json()
            return bool(result.get("data", {}).get("reactionCreate", {}).get("success"))
        except Exception:  # noqa: BLE001
            return False


async def fetch_linear_issue_details(issue_id: str) -> dict[str, Any] | None:
    """Fetch full issue details from Linear API including description and comments.

    Args:
        issue_id: The Linear issue ID

    Returns:
        Full issue data dict, or None if fetch failed
    """
    if not LINEAR_API_KEY:
        return None

    url = "https://api.linear.app/graphql"

    query = """
    query GetIssue($issueId: String!) {
        issue(id: $issueId) {
            id
            identifier
            title
            description
            url
            project {
                id
                name
            }
            team {
                id
                name
                key
            }
            comments {
                nodes {
                    id
                    body
                    createdAt
                    user {
                        id
                        name
                        email
                    }
                }
            }
        }
    }
    """

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                url,
                headers={
                    "Authorization": LINEAR_API_KEY,
                    "Content-Type": "application/json",
                },
                json={
                    "query": query,
                    "variables": {"issueId": issue_id},
                },
            )
            response.raise_for_status()
            result = response.json()

            return result.get("data", {}).get("issue")
        except httpx.HTTPError:
            return None


def generate_thread_id_from_issue(issue_id: str) -> str:
    """Generate a deterministic thread ID from a Linear issue ID.

    Args:
        issue_id: The Linear issue ID

    Returns:
        A UUID-formatted thread ID derived from the issue ID
    """
    hash_bytes = hashlib.sha256(f"linear-issue:{issue_id}".encode()).hexdigest()
    return (
        f"{hash_bytes[:8]}-{hash_bytes[8:12]}-{hash_bytes[12:16]}-"
        f"{hash_bytes[16:20]}-{hash_bytes[20:32]}"
    )


def generate_thread_id_from_github_issue(issue_id: str) -> str:
    """Generate a deterministic thread ID from a GitHub issue ID."""
    hash_bytes = hashlib.sha256(f"github-issue:{issue_id}".encode()).hexdigest()
    return (
        f"{hash_bytes[:8]}-{hash_bytes[8:12]}-{hash_bytes[12:16]}-"
        f"{hash_bytes[16:20]}-{hash_bytes[20:32]}"
    )


def generate_thread_id_from_slack_thread(channel_id: str, thread_id: str) -> str:
    """Generate a deterministic thread ID from a Slack thread identifier."""
    composite = f"{channel_id}:{thread_id}"
    md5_hex = hashlib.md5(composite.encode("utf-8")).hexdigest()
    return str(uuid.UUID(hex=md5_hex))


def _extract_repo_config_from_thread(thread: dict[str, Any]) -> dict[str, str] | None:
    """Extract repo config from persisted thread data."""
    metadata = thread.get("metadata")
    if not isinstance(metadata, dict):
        return None

    repo = metadata.get("repo")
    if isinstance(repo, dict):
        owner = repo.get("owner")
        name = repo.get("name")
        if isinstance(owner, str) and owner and isinstance(name, str) and name:
            return {"owner": owner, "name": name}

    owner = metadata.get("repo_owner")
    name = metadata.get("repo_name")
    if isinstance(owner, str) and owner and isinstance(name, str) and name:
        return {"owner": owner, "name": name}

    return None


def _is_not_found_error(exc: Exception) -> bool:
    """Best-effort check for LangGraph 404 errors."""
    return getattr(exc, "status_code", None) == 404


def _extract_branch_selection_from_thread(thread: dict[str, Any]) -> dict[str, str]:
    """Extract persisted branch selections from thread metadata."""
    metadata = thread.get("metadata")
    if not isinstance(metadata, dict):
        return {}

    selections: dict[str, str] = {}
    for key in ("base_branch", "branch_name"):
        value = metadata.get(key)
        if isinstance(value, str) and value:
            selections[key] = value
    return selections


def _is_repo_org_allowed(repo_config: dict[str, str]) -> bool:
    """Check if the repo owner/org is in the allowlist.

    Returns True if no allowlist is configured (empty ALLOWED_GITHUB_ORGS),
    or if the repo owner is in the allowlist.
    """
    if not ALLOWED_GITHUB_ORGS:
        return True
    owner = repo_config.get("owner", "").lower()
    return owner in ALLOWED_GITHUB_ORGS


async def _upsert_slack_thread_repo_metadata(
    thread_id: str, repo_config: dict[str, str], langgraph_client: LangGraphClient
) -> None:
    """Persist the selected repo config on the thread metadata."""
    await _upsert_thread_metadata(
        thread_id,
        {"repo": repo_config},
        langgraph_client,
        context="Slack thread repo metadata",
    )


async def _get_thread(thread_id: str, langgraph_client: LangGraphClient) -> dict[str, Any] | None:
    """Fetch a thread, returning None when it does not exist."""
    try:
        return await langgraph_client.threads.get(thread_id)
    except Exception as exc:  # noqa: BLE001
        if _is_not_found_error(exc):
            return None
        logger.exception("Failed to fetch thread %s", thread_id)
        return None


async def _upsert_telegram_thread_metadata(
    thread_id: str,
    metadata: dict[str, Any],
    langgraph_client: LangGraphClient,
) -> None:
    """Persist Telegram repo/branch selections on the LangGraph thread."""
    await _upsert_thread_metadata(
        thread_id,
        metadata,
        langgraph_client,
        context="Telegram metadata",
    )


async def _upsert_thread_metadata(
    thread_id: str,
    metadata: dict[str, Any],
    langgraph_client: LangGraphClient,
    *,
    context: str,
) -> None:
    """Persist thread metadata, creating the thread when needed."""
    try:
        await langgraph_client.threads.update(thread_id=thread_id, metadata=metadata)
    except Exception as exc:  # noqa: BLE001
        if _is_not_found_error(exc):
            try:
                await langgraph_client.threads.create(
                    thread_id=thread_id,
                    if_exists="do_nothing",
                    metadata=metadata,
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Failed to create thread %s while persisting %s",
                    thread_id,
                    context,
                )
            return
        logger.exception(
            "Failed to persist %s for thread %s",
            context,
            thread_id,
        )


def _build_selection(
    repo_config: dict[str, str],
    *,
    base_branch: str = "",
    branch_name: str = "",
) -> dict[str, Any]:
    return {
        "repo": repo_config,
        "base_branch": base_branch,
        "branch_name": branch_name,
    }


def _extract_confirmed_selection(thread: dict[str, Any]) -> dict[str, Any] | None:
    repo_config = _extract_repo_config_from_thread(thread)
    if not repo_config:
        return None
    branch_selection = _extract_branch_selection_from_thread(thread)
    return _build_selection(
        repo_config,
        base_branch=branch_selection.get("base_branch", ""),
        branch_name=branch_selection.get("branch_name", ""),
    )


def _extract_pending_repo_branch_confirmation(thread: dict[str, Any]) -> dict[str, Any] | None:
    metadata = thread.get("metadata")
    if not isinstance(metadata, dict):
        return None
    pending = metadata.get(_REPO_BRANCH_CONFIRMATION_KEY)
    if isinstance(pending, dict) and pending.get("awaiting") is True:
        return pending
    return None


def _selection_matches(left: dict[str, Any] | None, right: dict[str, Any] | None) -> bool:
    if not left or not right:
        return False
    left_repo = left.get("repo", {})
    right_repo = right.get("repo", {})
    return (
        left_repo.get("owner", "") == right_repo.get("owner", "")
        and left_repo.get("name", "") == right_repo.get("name", "")
        and left.get("base_branch", "") == right.get("base_branch", "")
        and left.get("branch_name", "") == right.get("branch_name", "")
    )


def _is_affirmative_confirmation(text: str) -> bool:
    normalized = " ".join(text.lower().split())
    return normalized in {"y", "yes", "ok", "okay", "confirm", "confirmed", "proceed"}


def _is_negative_confirmation(text: str) -> bool:
    normalized = " ".join(text.lower().split())
    return normalized in {"n", "no", "wrong", "incorrect"}


def _update_selection_from_text(
    text: str,
    current_selection: dict[str, Any],
    *,
    default_owner: str,
) -> tuple[dict[str, Any], bool]:
    updated = _build_selection(
        {
            "owner": current_selection["repo"]["owner"],
            "name": current_selection["repo"]["name"],
        },
        base_branch=current_selection.get("base_branch", ""),
        branch_name=current_selection.get("branch_name", ""),
    )
    changed = False

    repo_override = extract_repo_from_text(text, default_owner=default_owner)
    if repo_override:
        updated["repo"] = repo_override
        changed = True

    branch_overrides = extract_telegram_branch_overrides(text)
    if "base_branch" in branch_overrides:
        updated["base_branch"] = branch_overrides["base_branch"]
        changed = True
    if "branch_name" in branch_overrides:
        updated["branch_name"] = branch_overrides["branch_name"]
        changed = True

    return updated, changed


def _build_pending_confirmation_payload(
    selection: dict[str, Any],
    *,
    source: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    return {
        "awaiting": True,
        "source": source,
        "repo": selection["repo"],
        "base_branch": selection.get("base_branch", ""),
        "branch_name": selection.get("branch_name", ""),
        "request": request,
    }


def _build_confirmation_metadata(
    selection: dict[str, Any],
    pending_confirmation: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "repo": selection["repo"],
        "base_branch": selection.get("base_branch", ""),
        "branch_name": selection.get("branch_name", ""),
        _REPO_BRANCH_CONFIRMATION_KEY: pending_confirmation or {},
    }


def _format_slack_repo_branch_confirmation_message(selection: dict[str, Any]) -> str:
    repo = selection["repo"]
    base_branch = selection.get("base_branch") or "(not set)"
    branch_name = selection.get("branch_name") or "(not set)"
    return (
        "Before I start working, confirm the target repo and branch selection:\n"
        f"- Repository: `{repo['owner']}/{repo['name']}`\n"
        f"- Base branch: `{base_branch}`\n"
        f"- Working branch: `{branch_name}`\n\n"
        "Reply `yes` to proceed, or send corrected values like "
        "`repo:owner/name base:main branch:feature/x`."
    )


def _format_telegram_repo_branch_confirmation_message(selection: dict[str, Any]) -> str:
    repo = selection["repo"]
    base_branch = selection.get("base_branch") or "(not set)"
    branch_name = selection.get("branch_name") or "(not set)"
    return (
        "Before I start working, confirm the target repo and branch selection:\n"
        f"- Repository: <code>{repo['owner']}/{repo['name']}</code>\n"
        f"- Base branch: <code>{base_branch}</code>\n"
        f"- Working branch: <code>{branch_name}</code>\n\n"
        "Reply <code>yes</code> to proceed, or send corrected values like "
        "<code>repo:owner/name base:main branch:feature/x</code>."
    )


def _build_unconfirmed_selection_message(*, channel: str) -> str:
    if channel == "telegram":
        return (
            "I am waiting for repo/branch confirmation. Reply <code>yes</code> to use "
            "the shown selection, or send corrected <code>repo:</code>, <code>base:</code>, "
            "and <code>branch:</code> values."
        )
    return (
        "I am waiting for repo/branch confirmation. Reply `yes` to use the shown "
        "selection, or send corrected `repo:`, `base:`, and `branch:` values."
    )


def _resolve_telegram_selection(
    text: str,
    confirmed_selection: dict[str, Any] | None,
    *,
    default_owner: str,
    default_name: str,
) -> dict[str, Any]:
    repo_config = get_telegram_repo_config(
        text=text,
        default_owner=(confirmed_selection or {}).get("repo", {}).get("owner", default_owner),
        default_name=(confirmed_selection or {}).get("repo", {}).get("name", default_name),
    )
    branch_overrides = extract_telegram_branch_overrides(text)
    return _build_selection(
        repo_config,
        base_branch=branch_overrides.get(
            "base_branch",
            (confirmed_selection or {}).get("base_branch", ""),
        ),
        branch_name=branch_overrides.get(
            "branch_name",
            (confirmed_selection or {}).get("branch_name", ""),
        ),
    )


def _resolve_slack_selection(
    text: str,
    confirmed_selection: dict[str, Any] | None,
    *,
    default_owner: str,
    default_name: str,
) -> dict[str, Any]:
    repo_config = extract_repo_from_text(
        text,
        default_owner=(confirmed_selection or {}).get("repo", {}).get("owner", default_owner),
    )
    if not repo_config:
        if confirmed_selection:
            repo_config = confirmed_selection["repo"]
        else:
            repo_config = {"owner": default_owner, "name": default_name}
    branch_overrides = extract_telegram_branch_overrides(text)
    return _build_selection(
        repo_config,
        base_branch=branch_overrides.get(
            "base_branch",
            (confirmed_selection or {}).get("base_branch", ""),
        ),
        branch_name=branch_overrides.get(
            "branch_name",
            (confirmed_selection or {}).get("branch_name", ""),
        ),
    )


def _is_ai_message(payload: dict[str, Any]) -> bool:
    role = str(payload.get("role", "")).lower()
    msg_type = str(payload.get("type", "")).lower()
    return role == "assistant" or msg_type in {"ai", "aimessage", "aimessagechunk"}


def _extract_last_ai_message_text(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if isinstance(message, dict) and _is_ai_message(message):
            text = extract_text_content(message.get("content", message))
            if text:
                return text
    return ""


async def _telegram_typing_loop(chat_id: int, message_thread_id: int | None, stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        await send_telegram_chat_action(chat_id, message_thread_id=message_thread_id)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=4)
        except TimeoutError:
            continue


async def check_if_using_repo_msg_sent(
    channel_id: str, thread_ts: str, using_repo_str: str
) -> bool:
    thread_messages = await fetch_slack_thread_messages(channel_id, thread_ts)
    for message in thread_messages:
        if using_repo_str in message.get("text", ""):
            return True
    return False


async def get_slack_repo_config(
    message: str, channel_id: str, thread_ts: str
) -> dict[str, str]:
    """Resolve repository configuration for Slack-triggered runs."""
    default_owner = SLACK_REPO_OWNER.strip() or DEFAULT_REPO_OWNER
    default_name = SLACK_REPO_NAME.strip() or DEFAULT_REPO_NAME
    thread_id = generate_thread_id_from_slack_thread(channel_id, thread_ts)
    langgraph_client = get_client(url=LANGGRAPH_URL)

    repo_config = extract_repo_from_text(message, default_owner=default_owner)

    if not repo_config:
        try:
            thread = await langgraph_client.threads.get(thread_id)
            thread_repo_config = _extract_repo_config_from_thread(thread)
            if thread_repo_config:
                repo_config = thread_repo_config
        except Exception as exc:  # noqa: BLE001
            if not _is_not_found_error(exc):
                logger.exception(
                    "Failed to fetch Slack thread %s for repo resolution",
                    thread_id,
                )

    if not repo_config:
        repo_config = {"owner": default_owner, "name": default_name}

    using_repo_str = f"Using repository: `{repo_config['owner']}/{repo_config['name']}`"
    if not await check_if_using_repo_msg_sent(channel_id, thread_ts, using_repo_str):
        await post_slack_thread_reply(channel_id, thread_ts, using_repo_str)

    return repo_config


async def is_thread_active(thread_id: str) -> bool:
    """Check if a thread is currently active (has a running run).

    Args:
        thread_id: The LangGraph thread ID

    Returns:
        True if the thread status is "busy", False otherwise
    """
    langgraph_client = get_client(url=LANGGRAPH_URL)
    try:
        logger.debug("Fetching thread status for %s from %s", thread_id, LANGGRAPH_URL)
        thread = await langgraph_client.threads.get(thread_id)
        status = thread.get("status", "idle")
        logger.info(
            "Thread %s status check: status=%s, is_busy=%s",
            thread_id,
            status,
            status == "busy",
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "Failed to get thread status for %s: %s (type: %s) - assuming not active",
            thread_id,
            e,
            type(e).__name__,
        )
        status = "idle"
    return status == "busy"


async def _thread_exists(thread_id: str) -> bool:
    """Return whether a LangGraph thread already exists."""
    langgraph_client = get_client(url=LANGGRAPH_URL)
    try:
        await langgraph_client.threads.get(thread_id)
        return True
    except Exception as exc:  # noqa: BLE001
        if _is_not_found_error(exc):
            return False
        logger.warning("Failed to fetch thread %s, assuming it exists", thread_id)
        return True


async def queue_message_for_thread(
    thread_id: str, message_content: str | list[dict[str, Any]] | dict[str, Any]
) -> bool:
    """Queue a message for a thread that is currently active.

    Stores the message in the langgraph store, namespaced to the thread.
    Supports multiple queued messages by storing them as a list (FIFO order).
    The before_model middleware will pick them up and inject them into state.

    Args:
        thread_id: The LangGraph thread ID
        message_content: The message content to queue (text or content blocks)

    Returns:
        True if successfully queued, False otherwise
    """
    langgraph_client = get_client(url=LANGGRAPH_URL)
    try:
        namespace = ("queue", thread_id)
        key = "pending_messages"

        new_message = {"content": message_content}

        existing_messages: list[dict[str, Any]] = []
        try:
            existing_item = await langgraph_client.store.get_item(namespace, key)
            if existing_item and existing_item.get("value"):
                existing_messages = existing_item["value"].get("messages", [])
        except Exception:  # noqa: BLE001
            logger.debug("No existing queued messages for thread %s", thread_id)

        existing_messages.append(new_message)
        value = {"messages": existing_messages}

        logger.info(
            "Attempting to queue message for thread %s (total queued: %d)",
            thread_id,
            len(existing_messages),
        )
        await langgraph_client.store.put_item(namespace, key, value)
        logger.info("Successfully queued message for thread %s", thread_id)
        return True  # noqa: TRY300
    except Exception:
        logger.exception("Failed to queue message for thread %s", thread_id)
        return False


async def process_linear_issue(  # noqa: PLR0912, PLR0915
    issue_data: dict[str, Any], repo_config: dict[str, str]
) -> None:
    """Process a Linear issue by creating a new LangGraph thread and run.

    Args:
        issue_data: The Linear issue data from webhook (basic info only).
        repo_config: The repo configuration with owner and name.
    """
    issue_id = issue_data.get("id", "")
    logger.info(
        "Processing Linear issue %s for repo %s/%s",
        issue_id,
        repo_config.get("owner"),
        repo_config.get("name"),
    )

    triggering_comment_id = issue_data.get("triggering_comment_id", "")
    if triggering_comment_id:
        await react_to_linear_comment(triggering_comment_id, "👀")

    thread_id = generate_thread_id_from_issue(issue_id)

    full_issue = await fetch_linear_issue_details(issue_id)
    if not full_issue:
        full_issue = issue_data

    user_email = None
    user_name = None
    comment_author = issue_data.get("comment_author", {})
    if comment_author:
        user_email = comment_author.get("email")
        user_name = comment_author.get("name")
    if not user_email:
        creator = full_issue.get("creator", {})
        if creator:
            user_email = creator.get("email")
            user_name = user_name or creator.get("name")
    if not user_email:
        assignee = full_issue.get("assignee", {})
        if assignee:
            user_email = assignee.get("email")
            user_name = user_name or assignee.get("name")

    logger.info("User email for issue %s: %s", issue_id, user_email)

    title = full_issue.get("title", "No title")
    description = full_issue.get("description") or "No description"
    image_urls: list[str] = []
    description_image_urls = extract_image_urls(description)
    if description_image_urls:
        image_urls.extend(description_image_urls)
        logger.debug(
            "Found %d image URL(s) in issue description",
            len(description_image_urls),
        )

    comments = full_issue.get("comments", {}).get("nodes", [])
    comments_text = ""
    triggering_comment = issue_data.get("triggering_comment", "")
    triggering_comment_id = issue_data.get("triggering_comment_id", "")

    bot_message_prefixes = (
        "🔐 **GitHub Authentication Required**",
        "✅ **Pull Request Created**",
        "✅ **Pull Request Updated**",
        "**Pull Request Created**",
        "**Pull Request Updated**",
        "🤖 **Agent Response**",
        "❌ **Agent Error**",
    )

    comment_ids: set[str] = set()
    comment_id_to_index: dict[str, int] = {}
    if comments:
        for i, comment in enumerate(comments):
            comment_id = comment.get("id", "")
            if comment_id:
                comment_ids.add(comment_id)
                comment_id_to_index[comment_id] = i

        relevant_comments = []
        trigger_index = None
        if triggering_comment_id:
            trigger_index = comment_id_to_index.get(triggering_comment_id)
        if trigger_index is not None:
            relevant_comments = comments[trigger_index:]
            logger.debug(
                "Using triggering comment index %d to build relevant comments",
                trigger_index,
            )
        else:
            relevant_comments = get_recent_comments(comments, bot_message_prefixes)

        if relevant_comments:
            comments_text = "\n\n## Comments:\n"
            for comment in relevant_comments:
                user = comment.get("user") or {}
                author = user.get("name", "User")
                body = comment.get("body", "")
                body_image_urls = extract_image_urls(body)
                if body_image_urls:
                    image_urls.extend(body_image_urls)
                    logger.debug(
                        "Found %d image URL(s) in comment by %s",
                        len(body_image_urls),
                        author,
                    )
                if any(body.startswith(prefix) for prefix in bot_message_prefixes):
                    continue
                comments_text += f"\n**{author}:** {body}\n"

    if triggering_comment and triggering_comment_id not in comment_ids:
        if not comments_text:
            comments_text = "\n\n## Comments:\n"
        trigger_author = comment_author.get("name", "Unknown")
        trigger_body = triggering_comment
        trigger_image_urls = extract_image_urls(trigger_body)
        if trigger_image_urls:
            image_urls.extend(trigger_image_urls)
            logger.debug(
                "Found %d image URL(s) in triggering comment by %s",
                len(trigger_image_urls),
                trigger_author,
            )
        comments_text += f"\n**{trigger_author}:** {trigger_body}\n"
        logger.debug(
            "Appended triggering comment %s not present in issue comments list",
            triggering_comment_id or "<missing-id>",
        )

    identifier = full_issue.get("identifier", "") or issue_data.get("identifier", "")

    triggered_by_line = f"## Triggered by: {user_name}\n\n" if user_name else ""
    tag_instruction = (
        f"When calling linear_comment, tag @{user_name} if you are asking them a question, need their input, or are notifying them of something important (e.g. a completed PR). For simple answers, tagging is not required."
        if user_name
        else ""
    )
    prompt = (
        f"Please work on the following issue:\n\n"
        f"## Title: {title}\n\n"
        f"{triggered_by_line}"
        f"## Linear Ticket: {identifier} - Ticket ID: {issue_id}\n\n"
        f"## Description:\n{description}\n"
        f"{comments_text}\n\n"
        f"Please analyze this issue and implement the necessary changes. "
        f"When you're done, commit and push your changes. {tag_instruction}"
    )
    content_blocks: list[dict[str, Any]] = [create_text_block(prompt)]
    if image_urls:
        image_urls = dedupe_urls(image_urls)
        logger.info("Preparing %d image(s) for multimodal content", len(image_urls))
        logger.debug("Image URLs: %s", image_urls)

        async with httpx.AsyncClient() as client:
            for image_url in image_urls:
                image_block = await fetch_image_block(image_url, client)
                if image_block:
                    content_blocks.append(image_block)
        logger.info("Built %d content block(s) for prompt", len(content_blocks))

    linear_project_id = ""
    linear_issue_number = ""
    if identifier and "-" in identifier:
        parts = identifier.split("-", 1)
        linear_project_id = parts[0]
        linear_issue_number = parts[1]

    configurable: dict[str, Any] = {
        "repo": repo_config,
        "linear_issue": {
            "id": issue_id,
            "title": title,
            "url": full_issue.get("url", "") or issue_data.get("url", ""),
            "identifier": identifier,
            "linear_project_id": linear_project_id,
            "linear_issue_number": linear_issue_number,
            "triggering_user_name": user_name or "",
        },
        "user_email": user_email,
        "source": "linear",
    }

    logger.info("Checking if thread %s is active before creating run", thread_id)
    thread_active = await is_thread_active(thread_id)
    logger.info("Thread %s active status: %s", thread_id, thread_active)

    if thread_active:
        logger.info(
            "Thread %s is active (busy), will queue message instead of creating run",
            thread_id,
        )

        queued_payload = {"text": prompt, "image_urls": image_urls}
        queued = await queue_message_for_thread(
            thread_id=thread_id,
            message_content=queued_payload,
        )

        if queued:
            logger.info(
                "Message queued for thread %s, will be processed by middleware",
                thread_id,
            )
            langgraph_client = get_client(url=LANGGRAPH_URL)
            runs = await langgraph_client.runs.list(thread_id, limit=1)
            if runs:
                await post_linear_trace_comment(
                    issue_id, runs[0]["run_id"], triggering_comment_id
                )
        else:
            logger.error("Failed to queue message for thread %s", thread_id)
    else:
        logger.info("Creating LangGraph run for thread %s", thread_id)
        langgraph_client = get_client(url=LANGGRAPH_URL)
        run = await langgraph_client.runs.create(
            thread_id,
            "agent",
            input={"messages": [{"role": "user", "content": content_blocks}]},
            config={"configurable": configurable, "metadata": _AGENT_VERSION_METADATA},
            if_not_exists="create",
        )
        logger.info("LangGraph run created successfully for thread %s", thread_id)
        await post_linear_trace_comment(issue_id, run["run_id"], triggering_comment_id)


async def process_slack_mention(
    event_data: dict[str, Any],
    repo_config: dict[str, str],
    *,
    base_branch: str = "",
    branch_name: str = "",
) -> None:
    """Process a Slack app mention by creating or interrupting a thread run."""
    channel_id = event_data.get("channel_id", "")
    thread_ts = event_data.get("thread_ts", "")
    event_ts = event_data.get("event_ts", "")
    user_id = event_data.get("user_id", "")
    text = event_data.get("text", "")
    bot_user_id = event_data.get("bot_user_id", "")

    if not channel_id or not thread_ts or not event_ts:
        logger.warning(
            "Missing Slack event fields (channel_id=%s, thread_ts=%s, event_ts=%s)",
            channel_id,
            thread_ts,
            event_ts,
        )
        return

    reacted = await add_slack_reaction(channel_id, event_ts, "eyes")
    if not reacted:
        logger.debug(
            "Unable to add eyes reaction for Slack message ts=%s in channel=%s",
            event_ts,
            channel_id,
        )

    thread_id = generate_thread_id_from_slack_thread(channel_id, thread_ts)

    user_email = None
    user_name = ""
    if user_id:
        slack_user = await get_slack_user_info(user_id)
        if slack_user:
            profile = slack_user.get("profile", {})
            if isinstance(profile, dict):
                user_email = profile.get("email")
                user_name = (
                    profile.get("display_name")
                    or profile.get("real_name")
                    or slack_user.get("real_name")
                    or slack_user.get("name")
                    or ""
                )

    thread_messages = await fetch_slack_thread_messages(channel_id, thread_ts)
    if not any(str(message.get("ts")) == str(event_ts) for message in thread_messages):
        thread_messages.append({"ts": event_ts, "text": text, "user": user_id})

    context_messages, context_mode = select_slack_context_messages(
        thread_messages, event_ts, bot_user_id, SLACK_BOT_USERNAME
    )
    context_user_ids = [
        value
        for value in (message.get("user") for message in context_messages)
        if isinstance(value, str) and value
    ]
    user_names_by_id = await get_slack_user_names(context_user_ids)
    if user_id and user_name and user_id not in user_names_by_id:
        user_names_by_id[user_id] = user_name
    context_text = format_slack_messages_for_prompt(
        context_messages,
        user_names_by_id,
        bot_user_id=bot_user_id,
        bot_username=SLACK_BOT_USERNAME,
    )
    context_source = (
        "the previous message where I was tagged"
        if context_mode == "last_mention"
        else "the beginning of the thread"
    )
    clean_text = (
        strip_bot_mention(text, bot_user_id, bot_username=SLACK_BOT_USERNAME)
        or "(no text in mention)"
    )
    trigger_user = user_name or (f"<@{user_id}>" if user_id else "Unknown user")

    prompt = "".join(
        [
            "You were mentioned in Slack.\n\n",
            f"## Repository\n{repo_config.get('owner')}/{repo_config.get('name')}\n\n",
            f"## Base Branch\n{base_branch}\n\n" if base_branch else "",
            f"## Working Branch\n{branch_name}\n\n" if branch_name else "",
            f"## Triggered by\n{trigger_user}\n\n",
            f"## Slack Thread\n- Channel: {channel_id}\n- Thread TS: {thread_ts}\n",
            f"- Context starts at: {context_source}\n\n",
            f"## Conversation Context\n{context_text}\n\n",
            f"## Latest Mention Request\n{clean_text}\n\n",
            "The repository and branch selection were already confirmed by the user. "
            "Use `slack_thread_reply` to communicate in this Slack thread for clarifications, "
            "status updates, and final summaries.",
        ]
    )
    content_blocks: list[dict[str, Any]] = [create_text_block(prompt)]

    image_urls = dedupe_urls(
        [
            url
            for msg in context_messages
            for url in extract_image_urls(msg.get("text", ""))
        ]
        + [
            f["url_private"]
            for msg in context_messages
            for f in msg.get("files", [])
            if isinstance(f, dict)
            and f.get("mimetype", "").startswith("image/")
            and f.get("url_private")
        ]
    )
    if image_urls:
        logger.info("Preparing %d image(s) for Slack mention", len(image_urls))
        async with httpx.AsyncClient() as http_client:
            for image_url in image_urls:
                image_block = await fetch_image_block(image_url, http_client)
                if image_block:
                    content_blocks.append(image_block)

    configurable: dict[str, Any] = {
        "repo": repo_config,
        "slack_thread": {
            "channel_id": channel_id,
            "thread_ts": thread_ts,
            "triggering_user_id": user_id,
            "triggering_user_name": user_name,
            "triggering_user_email": user_email,
            "triggering_event_ts": event_ts,
        },
        "user_email": user_email,
        "source": "slack",
    }
    if base_branch:
        configurable["base_branch"] = base_branch
    if branch_name:
        configurable["branch_name"] = branch_name

    langgraph_client = get_client(url=LANGGRAPH_URL)
    await _upsert_thread_metadata(
        thread_id,
        _build_confirmation_metadata(
            _build_selection(
                repo_config,
                base_branch=base_branch,
                branch_name=branch_name,
            ),
            pending_confirmation=None,
        ),
        langgraph_client,
        context="Slack thread repo/branch metadata",
    )

    thread_active = await is_thread_active(thread_id)
    if thread_active:
        logger.info(
            "Thread %s is active, queuing Slack message for middleware pickup",
            thread_id,
        )
        queued_payload = {"text": prompt, "image_urls": []}
        queued = await queue_message_for_thread(
            thread_id=thread_id,
            message_content=queued_payload,
        )
        if queued:
            logger.info("Slack message queued for thread %s", thread_id)
        else:
            logger.error("Failed to queue Slack message for thread %s", thread_id)
        return

    run = await langgraph_client.runs.create(
        thread_id,
        "agent",
        input={"messages": [{"role": "user", "content": content_blocks}]},
        config={
            "configurable": configurable,
            "metadata": {
                **_AGENT_VERSION_METADATA,
                **({"base_branch": base_branch} if base_branch else {}),
                **({"branch_name": branch_name} if branch_name else {}),
            },
        },
        if_not_exists="create",
        multitask_strategy="interrupt",
    )
    await post_slack_trace_reply(channel_id, thread_ts, run["run_id"])


def verify_linear_signature(body: bytes, signature: str, secret: str) -> bool:
    """Verify the Linear webhook signature.

    Args:
        body: Raw request body bytes
        signature: The Linear-Signature header value
        secret: The webhook signing secret

    Returns:
        True if signature is valid, False otherwise
    """
    if not secret:
        logger.warning(
            "LINEAR_WEBHOOK_SECRET is not configured — rejecting webhook request"
        )
        return False

    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()

    return hmac.compare_digest(expected, signature)


@app.post("/webhooks/linear")
async def linear_webhook(  # noqa: PLR0911, PLR0912, PLR0915
    request: Request, background_tasks: BackgroundTasks
) -> dict[str, str]:
    """Handle Linear webhooks.

    Triggers a new LangGraph run when an issue gets the 'open-swe' label added.
    """
    logger.info("Received Linear webhook")
    body = await request.body()

    signature = request.headers.get("Linear-Signature", "")
    if not verify_linear_signature(body, signature, LINEAR_WEBHOOK_SECRET):
        logger.warning("Invalid webhook signature")
        raise HTTPException(status_code=401, detail="Invalid signature")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        logger.exception("Failed to parse webhook JSON")
        return {"status": "error", "message": "Invalid JSON"}

    if payload.get("type") != "Comment":
        logger.debug("Ignoring webhook: not a Comment event")
        return {"status": "ignored", "reason": "Not a Comment event"}

    action = payload.get("action")
    if action != "create":
        logger.debug("Ignoring webhook: action is %s, not create", action)
        return {
            "status": "ignored",
            "reason": f"Comment action is '{action}', only processing 'create'",
        }

    data = payload.get("data", {})

    if data.get("botActor"):
        logger.debug("Ignoring webhook: comment is from a bot")
        return {"status": "ignored", "reason": "Comment is from a bot"}

    comment_body = data.get("body", "")
    bot_message_prefixes = [
        "🔐 **GitHub Authentication Required**",
        "✅ **Pull Request Created**",
        "✅ **Pull Request Updated**",
        "**Pull Request Created**",
        "**Pull Request Updated**",
        "🤖 **Agent Response**",
        "❌ **Agent Error**",
    ]
    for prefix in bot_message_prefixes:
        if comment_body.startswith(prefix):
            logger.debug("Ignoring webhook: comment is our own bot message")
            return {"status": "ignored", "reason": "Comment is our own bot message"}
    if "@openswe" not in comment_body.lower():
        logger.debug("Ignoring webhook: comment doesn't mention @openswe")
        return {"status": "ignored", "reason": "Comment doesn't mention @openswe"}

    issue = data.get("issue", {})
    if not issue:
        logger.debug("Ignoring webhook: no issue data in comment")
        return {"status": "ignored", "reason": "No issue data in comment"}

    # Fetch full issue details to get project info (webhook doesn't include it)
    issue_id = issue.get("id", "")
    full_issue = await fetch_linear_issue_details(issue_id)
    if not full_issue:
        logger.warning("Failed to fetch full issue details, using webhook data")
        full_issue = issue

    repo_config = extract_repo_from_text(comment_body, default_owner=DEFAULT_REPO_OWNER)

    if repo_config:
        logger.debug(
            "Using repo from comment body: %s/%s",
            repo_config["owner"],
            repo_config["name"],
        )
    else:
        team = full_issue.get("team", {})
        team_name = team.get("name", "") if team else ""
        project = full_issue.get("project")
        project_name = project.get("name", "") if project else ""

        team_identifier = team_name.strip() if team_name else ""
        project_key = project_name.strip() if project_name else ""

        repo_config = get_repo_config_from_team_mapping(team_identifier, project_key)

        logger.debug(
            "Team/project lookup result",
            extra={
                "team_name": team_identifier,
                "project_name": project_key,
                "repo_config": repo_config,
            },
        )

    if not _is_repo_org_allowed(repo_config):
        logger.warning(
            "Rejecting Linear webhook: org '%s' not in ALLOWED_GITHUB_ORGS",
            repo_config.get("owner"),
        )
        return {"status": "ignored", "reason": "Repository org not in allowlist"}

    repo_owner = repo_config["owner"]
    repo_name = repo_config["name"]

    issue["triggering_comment"] = comment_body
    issue["triggering_comment_id"] = data.get("id", "")
    comment_user = data.get("user", {})
    if comment_user:
        issue["comment_author"] = comment_user

    logger.info(
        "Accepted webhook for issue '%s' (%s), scheduling background task",
        issue.get("title"),
        issue.get("id"),
    )
    background_tasks.add_task(process_linear_issue, issue, repo_config)

    return {
        "status": "accepted",
        "message": f"Processing issue '{issue.get('title')}' for repo {repo_owner}/{repo_name}",
    }


@app.get("/webhooks/linear")
async def linear_webhook_verify() -> dict[str, str]:
    """Verify endpoint for Linear webhook setup."""
    return {"status": "ok", "message": "Linear webhook endpoint is active"}


@app.post("/webhooks/slack")
async def slack_webhook(
    request: Request, background_tasks: BackgroundTasks
) -> dict[str, str]:
    """Handle Slack Event API webhooks for app mentions."""
    body = await request.body()

    signature = request.headers.get("X-Slack-Signature", "")
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
    if not verify_slack_signature(
        body=body,
        timestamp=timestamp,
        signature=signature,
        secret=SLACK_SIGNING_SECRET,
    ):
        logger.warning("Invalid Slack signature")
        raise HTTPException(status_code=401, detail="Invalid signature")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        logger.exception("Failed to parse Slack webhook JSON")
        return {"status": "error", "message": "Invalid JSON"}

    if payload.get("type") == "url_verification":
        challenge = payload.get("challenge", "")
        return {"challenge": challenge}

    if payload.get("type") != "event_callback":
        return {"status": "ignored", "reason": "Not an event callback"}

    event = payload.get("event", {})
    if event.get("type") != "app_mention":
        message_text = event.get("text", "")
        has_username_mention = bool(
            event.get("type") == "message"
            and SLACK_BOT_USERNAME
            and f"@{SLACK_BOT_USERNAME}" in message_text
        )
        has_id_mention = bool(
            event.get("type") == "message"
            and SLACK_BOT_USER_ID
            and f"<@{SLACK_BOT_USER_ID}>" in message_text
        )
        if not (has_username_mention or has_id_mention):
            return {"status": "ignored", "reason": "Not an app_mention event"}

    if event.get("subtype") == "bot_message" or event.get("bot_id"):
        return {"status": "ignored", "reason": "Event from a bot"}

    channel_id = event.get("channel", "")
    event_ts = event.get("ts", "")
    thread_ts = event.get("thread_ts") or event_ts
    user_id = event.get("user", "")
    text = event.get("text", "")
    if not channel_id or not event_ts or not thread_ts:
        return {"status": "ignored", "reason": "Missing channel/thread timestamp"}

    bot_user_id = SLACK_BOT_USER_ID
    if not bot_user_id:
        authorizations = payload.get("authorizations", [])
        if isinstance(authorizations, list) and authorizations:
            auth_user_id = authorizations[0].get("user_id")
            if isinstance(auth_user_id, str):
                bot_user_id = auth_user_id
    if not bot_user_id:
        authed_users = payload.get("authed_users", [])
        if isinstance(authed_users, list) and authed_users:
            first_user = authed_users[0]
            if isinstance(first_user, str):
                bot_user_id = first_user

    if bot_user_id and user_id == bot_user_id:
        return {"status": "ignored", "reason": "Event from this bot user"}

    event_data = {
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "event_ts": event_ts,
        "user_id": user_id,
        "text": text,
        "bot_user_id": bot_user_id,
    }
    clean_text = strip_bot_mention(text, bot_user_id, bot_username=SLACK_BOT_USERNAME) or text
    thread_id = generate_thread_id_from_slack_thread(channel_id, thread_ts)
    langgraph_client = get_client(url=LANGGRAPH_URL)
    existing_thread = await _get_thread(thread_id, langgraph_client)
    confirmed_selection = _extract_confirmed_selection(existing_thread or {})
    pending_confirmation = _extract_pending_repo_branch_confirmation(existing_thread or {})

    if pending_confirmation and pending_confirmation.get("source") == "slack":
        pending_selection = _build_selection(
            pending_confirmation["repo"],
            base_branch=pending_confirmation.get("base_branch", ""),
            branch_name=pending_confirmation.get("branch_name", ""),
        )
        updated_selection, has_corrections = _update_selection_from_text(
            clean_text,
            pending_selection,
            default_owner=pending_selection["repo"]["owner"],
        )
        if has_corrections:
            if not _is_repo_org_allowed(updated_selection["repo"]):
                logger.warning(
                    "Rejecting Slack webhook correction: org '%s' not in ALLOWED_GITHUB_ORGS",
                    updated_selection["repo"].get("owner"),
                )
                return {"status": "ignored", "reason": "Repository org not in allowlist"}
            await _upsert_thread_metadata(
                thread_id,
                _build_confirmation_metadata(
                    confirmed_selection or updated_selection,
                    _build_pending_confirmation_payload(
                        updated_selection,
                        source="slack",
                        request=pending_confirmation.get("request", {}),
                    ),
                ),
                langgraph_client,
                context="Slack repo/branch confirmation correction",
            )
            await post_slack_thread_reply(
                channel_id,
                thread_ts,
                _format_slack_repo_branch_confirmation_message(updated_selection),
            )
            return {"status": "accepted", "message": "Slack repo/branch confirmation updated"}

        if _is_affirmative_confirmation(clean_text):
            selection = pending_selection
            if not _is_repo_org_allowed(selection["repo"]):
                logger.warning(
                    "Rejecting Slack confirmation: org '%s' not in ALLOWED_GITHUB_ORGS",
                    selection["repo"].get("owner"),
                )
                return {"status": "ignored", "reason": "Repository org not in allowlist"}
            await _upsert_thread_metadata(
                thread_id,
                _build_confirmation_metadata(selection, pending_confirmation=None),
                langgraph_client,
                context="Slack confirmed repo/branch selection",
            )
            pending_event_data = pending_confirmation.get("request", {}).get("event_data", {})
            background_tasks.add_task(
                process_slack_mention,
                pending_event_data,
                selection["repo"],
                base_branch=selection.get("base_branch", ""),
                branch_name=selection.get("branch_name", ""),
            )
            return {"status": "accepted", "message": "Slack confirmation received; processing queued task"}

        await post_slack_thread_reply(
            channel_id,
            thread_ts,
            _build_unconfirmed_selection_message(channel="slack"),
        )
        return {"status": "accepted", "message": "Slack confirmation still pending"}

    resolved_selection = _resolve_slack_selection(
        clean_text,
        confirmed_selection,
        default_owner=SLACK_REPO_OWNER.strip() or DEFAULT_REPO_OWNER,
        default_name=SLACK_REPO_NAME.strip() or DEFAULT_REPO_NAME,
    )

    if not _is_repo_org_allowed(resolved_selection["repo"]):
        logger.warning(
            "Rejecting Slack webhook: org '%s' not in ALLOWED_GITHUB_ORGS",
            resolved_selection["repo"].get("owner"),
        )
        return {"status": "ignored", "reason": "Repository org not in allowlist"}

    if not confirmed_selection or not _selection_matches(confirmed_selection, resolved_selection):
        await _upsert_thread_metadata(
            thread_id,
            _build_confirmation_metadata(
                confirmed_selection or resolved_selection,
                _build_pending_confirmation_payload(
                    resolved_selection,
                    source="slack",
                    request={"event_data": event_data},
                ),
            ),
            langgraph_client,
            context="Slack pending repo/branch confirmation",
        )
        await post_slack_thread_reply(
            channel_id,
            thread_ts,
            _format_slack_repo_branch_confirmation_message(resolved_selection),
        )
        return {"status": "accepted", "message": "Slack repo/branch confirmation requested"}

    background_tasks.add_task(
        process_slack_mention,
        event_data,
        resolved_selection["repo"],
        base_branch=resolved_selection.get("base_branch", ""),
        branch_name=resolved_selection.get("branch_name", ""),
    )

    return {"status": "accepted", "message": "Slack mention queued"}


@app.get("/webhooks/slack")
async def slack_webhook_verify() -> dict[str, str]:
    """Verify endpoint for Slack webhook setup."""
    return {"status": "ok", "message": "Slack webhook endpoint is active"}


async def _process_telegram_task(
    request_context: dict[str, Any],
    repo_config: dict[str, str],
    *,
    base_branch: str = "",
    branch_name: str = "",
) -> None:
    chat_id = request_context["chat_id"]
    message_id = request_context["message_id"]
    message_thread_id = request_context.get("message_thread_id")
    user_id = request_context["user_id"]
    user_name = request_context["user_name"]
    clean_text = request_context["clean_text"]
    chat_description = request_context["chat_description"]
    thread_id = request_context["thread_id"]

    langgraph_client = get_client(url=LANGGRAPH_URL)
    prompt_sections = [
        "You were sent a message via Telegram.\n\n",
        f"## Repository\n{repo_config.get('owner')}/{repo_config.get('name')}\n\n",
    ]
    if base_branch:
        prompt_sections.append(f"## Base Branch\n{base_branch}\n\n")
    if branch_name:
        prompt_sections.append(f"## Working Branch\n{branch_name}\n\n")
    prompt_sections.extend(
        [
            f"## Triggered by\n{user_name}\n\n",
            f"## Telegram Context\n- {chat_description}\n- Chat ID: {chat_id}\n\n",
            f"## Message\n{clean_text}\n\n",
            "The repository and branch selection were already confirmed by the user. "
            "Telegram progress mode is enabled for this run. Send short milestone "
            "updates with `telegram_reply` only at important moments, such as when "
            "you start implementation, move to verification, hit a meaningful "
            "blocker, or need to explain a major next step. Keep those updates "
            "brief and practical, and do not send more than 2 interim milestone "
            "messages during a normal run. The main Telegram reply is sent "
            "automatically after the run completes.",
        ]
    )
    prompt = "".join(prompt_sections)
    content_blocks: list[dict[str, Any]] = [create_text_block(prompt)]

    configurable: dict[str, Any] = {
        "repo": repo_config,
        "telegram_chat": {
            "chat_id": chat_id,
            "reply_to_message_id": message_id,
            "message_thread_id": message_thread_id,
            "triggering_user_id": user_id,
            "triggering_user_name": user_name,
        },
        "telegram_progress_mode": "milestones",
        "source": "telegram",
    }
    if base_branch:
        configurable["base_branch"] = base_branch
    if branch_name:
        configurable["branch_name"] = branch_name

    await _upsert_telegram_thread_metadata(
        thread_id,
        _build_confirmation_metadata(
            _build_selection(repo_config, base_branch=base_branch, branch_name=branch_name),
            pending_confirmation=None,
        ),
        langgraph_client,
    )

    thread_active = await is_thread_active(thread_id)
    if thread_active:
        logger.info(
            "Thread %s is active, queuing Telegram message for middleware pickup",
            thread_id,
        )
        queued = await queue_message_for_thread(
            thread_id=thread_id,
            message_content={"text": prompt, "image_urls": []},
        )
        if queued:
            logger.info("Telegram message queued for thread %s", thread_id)
            await send_telegram_message(
                chat_id,
                "I got your follow-up and will apply it in the current run.",
                reply_to_message_id=message_id,
                message_thread_id=message_thread_id,
            )
        else:
            logger.error("Failed to queue Telegram message for thread %s", thread_id)
        return

    await send_telegram_message(
        chat_id,
        "Working on it. I’ll send short updates at important steps.",
        reply_to_message_id=message_id,
        message_thread_id=message_thread_id,
    )
    await send_telegram_chat_action(chat_id, message_thread_id=message_thread_id)
    typing_stop = asyncio.Event()
    typing_task = asyncio.create_task(_telegram_typing_loop(chat_id, message_thread_id, typing_stop))
    try:
        final_state = await langgraph_client.runs.wait(
            thread_id,
            "agent",
            input={"messages": [{"role": "user", "content": content_blocks}]},
            config={
                "configurable": configurable,
                "metadata": {
                    **_AGENT_VERSION_METADATA,
                    **({"base_branch": base_branch} if base_branch else {}),
                    **({"branch_name": branch_name} if branch_name else {}),
                },
            },
            if_not_exists="create",
            multitask_strategy="interrupt",
        )
    finally:
        typing_stop.set()
        await typing_task

    final_text = _extract_last_ai_message_text((final_state or {}).get("messages"))
    if not final_text:
        final_text = "I finished the run, but I do not have a response to show yet."
    await send_telegram_message(
        chat_id,
        final_text,
        reply_to_message_id=message_id,
        message_thread_id=message_thread_id,
    )


async def process_telegram_message(
    update: dict[str, Any],
    bot_username: str,
) -> None:
    """Process an incoming Telegram message update with repo/branch confirmation."""
    message = update.get("message", {})
    chat = message.get("chat", {})
    chat_id: int = chat.get("id", 0)
    chat_type: str = chat.get("type", "private")  # private, group, supergroup, channel
    message_id: int = message.get("message_id", 0)
    message_thread_id: int | None = message.get(
        "message_thread_id"
    )  # forum topics only
    text: str = message.get("text", "") or message.get("caption", "")
    from_user = message.get("from", {})
    user_id: int = from_user.get("id", 0)
    first_name: str = from_user.get("first_name", "")
    last_name: str = from_user.get("last_name", "")
    username: str = from_user.get("username", "")
    user_name = f"{first_name} {last_name}".strip() or username or str(user_id)

    if not chat_id or not text:
        logger.debug("Skipping Telegram message with no chat_id or text")
        return

    # In group/supergroup chats, only react to @bot_username mentions.
    is_private = chat_type == "private"
    if not is_private and not is_bot_mentioned(text, bot_username):
        logger.debug("Skipping Telegram group message without bot mention")
        return

    clean_text = telegram_strip_bot_mention(text, bot_username) or text

    thread_id = generate_thread_id_from_telegram_chat(chat_id, message_thread_id)

    langgraph_client = get_client(url=LANGGRAPH_URL)
    existing_thread = await _get_thread(thread_id, langgraph_client)
    confirmed_selection = _extract_confirmed_selection(existing_thread or {})
    pending_confirmation = _extract_pending_repo_branch_confirmation(existing_thread or {})

    default_owner = (
        confirmed_selection["repo"].get("owner")
        if confirmed_selection
        else os.environ.get("TELEGRAM_REPO_OWNER", "").strip() or DEFAULT_REPO_OWNER
    )
    default_name = (
        confirmed_selection["repo"].get("name")
        if confirmed_selection
        else os.environ.get("TELEGRAM_REPO_NAME", "").strip() or DEFAULT_REPO_NAME
    )

    chat_title = chat.get("title", "")
    chat_description = (
        f"Chat: {chat_title} ({chat_type})" if chat_title else f"Chat type: {chat_type}"
    )
    request_context = {
        "chat_id": chat_id,
        "message_id": message_id,
        "message_thread_id": message_thread_id,
        "user_id": user_id,
        "user_name": user_name,
        "clean_text": clean_text,
        "chat_description": chat_description,
        "thread_id": thread_id,
    }

    if pending_confirmation and pending_confirmation.get("source") == "telegram":
        pending_selection = _build_selection(
            pending_confirmation["repo"],
            base_branch=pending_confirmation.get("base_branch", ""),
            branch_name=pending_confirmation.get("branch_name", ""),
        )
        updated_selection, has_corrections = _update_selection_from_text(
            clean_text,
            pending_selection,
            default_owner=pending_selection["repo"]["owner"],
        )
        if has_corrections:
            if not _is_repo_org_allowed(updated_selection["repo"]):
                logger.warning(
                    "Rejecting Telegram correction: org '%s' not in ALLOWED_GITHUB_ORGS",
                    updated_selection["repo"].get("owner"),
                )
                return
            await _upsert_telegram_thread_metadata(
                thread_id,
                _build_confirmation_metadata(
                    confirmed_selection or updated_selection,
                    _build_pending_confirmation_payload(
                        updated_selection,
                        source="telegram",
                        request=pending_confirmation.get("request", {}),
                    ),
                ),
                langgraph_client,
            )
            await send_telegram_message(
                chat_id,
                _format_telegram_repo_branch_confirmation_message(updated_selection),
                reply_to_message_id=message_id,
                message_thread_id=message_thread_id,
            )
            return

        if _is_affirmative_confirmation(clean_text):
            selection = pending_selection
            if not _is_repo_org_allowed(selection["repo"]):
                logger.warning(
                    "Rejecting Telegram confirmation: org '%s' not in ALLOWED_GITHUB_ORGS",
                    selection["repo"].get("owner"),
                )
                return
            await _upsert_telegram_thread_metadata(
                thread_id,
                _build_confirmation_metadata(selection, pending_confirmation=None),
                langgraph_client,
            )
            pending_request = pending_confirmation.get("request", {})
            await _process_telegram_task(
                {
                    **request_context,
                    **pending_request,
                    "thread_id": thread_id,
                    "chat_id": chat_id,
                    "message_thread_id": message_thread_id,
                },
                selection["repo"],
                base_branch=selection.get("base_branch", ""),
                branch_name=selection.get("branch_name", ""),
            )
            return

        await send_telegram_message(
            chat_id,
            _build_unconfirmed_selection_message(channel="telegram"),
            reply_to_message_id=message_id,
            message_thread_id=message_thread_id,
        )
        return

    resolved_selection = _resolve_telegram_selection(
        clean_text,
        confirmed_selection,
        default_owner=default_owner,
        default_name=default_name,
    )
    if not _is_repo_org_allowed(resolved_selection["repo"]):
        logger.warning(
            "Rejecting Telegram message: org '%s' not in ALLOWED_GITHUB_ORGS",
            resolved_selection["repo"].get("owner"),
        )
        return

    if not confirmed_selection or not _selection_matches(confirmed_selection, resolved_selection):
        await _upsert_telegram_thread_metadata(
            thread_id,
            _build_confirmation_metadata(
                confirmed_selection or resolved_selection,
                _build_pending_confirmation_payload(
                    resolved_selection,
                    source="telegram",
                    request={
                        "message_id": message_id,
                        "user_id": user_id,
                        "user_name": user_name,
                        "clean_text": clean_text,
                        "chat_description": chat_description,
                    },
                ),
            ),
            langgraph_client,
        )
        await send_telegram_message(
            chat_id,
            _format_telegram_repo_branch_confirmation_message(resolved_selection),
            reply_to_message_id=message_id,
            message_thread_id=message_thread_id,
        )
        return

    await _process_telegram_task(
        request_context,
        resolved_selection["repo"],
        base_branch=resolved_selection.get("base_branch", ""),
        branch_name=resolved_selection.get("branch_name", ""),
    )


@app.post("/webhooks/telegram")
async def telegram_webhook(
    request: Request, background_tasks: BackgroundTasks
) -> dict[str, str]:
    """Handle Telegram Bot API webhook updates."""
    secret_token = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if not verify_telegram_secret(secret_token, TELEGRAM_WEBHOOK_SECRET):
        logger.warning("Invalid Telegram webhook secret token")
        raise HTTPException(status_code=401, detail="Invalid secret token")

    body = await request.body()
    try:
        update: dict[str, Any] = json.loads(body)
    except json.JSONDecodeError:
        logger.exception("Failed to parse Telegram webhook JSON")
        return {"status": "error", "message": "Invalid JSON"}

    # Only handle new messages (not edits, channel posts, etc.)
    if "message" not in update:
        return {"status": "ignored", "reason": "Not a message update"}

    background_tasks.add_task(process_telegram_message, update, TELEGRAM_BOT_USERNAME)
    return {"status": "accepted", "message": "Telegram message queued"}


@app.get("/webhooks/telegram")
async def telegram_webhook_verify() -> dict[str, str]:
    """Verify endpoint for Telegram webhook setup."""
    return {"status": "ok", "message": "Telegram webhook endpoint is active"}


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "healthy"}


_SUPPORTED_GH_EVENTS = frozenset(
    ["issue_comment", "issues", "pull_request_review_comment", "pull_request_review"]
)
_SUPPORTED_GH_ISSUE_ACTIONS = frozenset(["edited", "opened", "reopened"])


def _build_github_issue_comments_text(comments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for comment in comments:
        body = comment.get("body", "")
        if not body or any(
            body.startswith(prefix) for prefix in _GITHUB_BOT_MESSAGE_PREFIXES
        ):
            continue
        author = comment.get("author", "unknown")
        formatted_body = format_github_comment_body_for_prompt(author, body)
        lines.append(f"\n**{author}:**\n{formatted_body}\n")

    if not lines:
        return ""
    return "\n\n## Comments:\n" + "".join(lines)


def build_github_issue_prompt(
    repo_config: dict[str, str],
    issue_number: int,
    issue_id: str,
    title: str,
    body: str,
    comments: list[dict[str, Any]],
    *,
    github_login: str,
    issue_author: str = "",
) -> str:
    """Build the user prompt for a GitHub issue-triggered run."""
    triggered_by_line = f"## Triggered by: {github_login}\n\n" if github_login else ""
    comments_text = _build_github_issue_comments_text(comments)
    sanitized_title = sanitize_github_comment_body(title)
    formatted_body = format_github_comment_body_for_prompt(
        issue_author or github_login, body
    )
    return (
        "Please work on the following GitHub issue:\n\n"
        f"## Repository: {repo_config.get('owner')}/{repo_config.get('name')}\n\n"
        f"{triggered_by_line}"
        f"## GitHub Issue: #{issue_number} - Issue ID: {issue_id}\n\n"
        f"## Title: {sanitized_title}\n\n"
        f"## Description:\n{formatted_body}\n"
        f"{comments_text}\n\n"
        "Please analyze this issue and implement the necessary changes. "
        "When you need to communicate on GitHub, use `github_comment` with the issue number."
    )


def build_github_issue_followup_prompt(github_login: str, comment_body: str) -> str:
    """Build the prompt for a follow-up GitHub issue comment."""
    return f"**{github_login}:**\n{format_github_comment_body_for_prompt(github_login, comment_body)}"


def build_github_issue_update_prompt(github_login: str, title: str, body: str) -> str:
    """Build the prompt for a follow-up GitHub issue title/body update."""
    sanitized_title = sanitize_github_comment_body(title)
    formatted_body = format_github_comment_body_for_prompt(github_login, body)
    return (
        f"**{github_login}:** updated the GitHub issue title/body.\n\n"
        f"Title: {sanitized_title}\n\n"
        f"Description:\n{formatted_body}"
    )


async def _trigger_or_queue_run(
    thread_id: str,
    prompt: str,
    *,
    github_login: str,
    github_user_id: int | None,
    repo_config: dict[str, str],
    pr_number: int,
    base_branch: str = "",
) -> None:
    """Create a new agent run or queue the message if the thread is busy."""
    thread_active = await is_thread_active(thread_id)
    if thread_active:
        logger.info("Thread %s is busy, queuing GitHub PR comment message", thread_id)
        await queue_message_for_thread(thread_id, prompt)
        return

    logger.info(
        "Creating LangGraph run for thread %s from GitHub PR comment", thread_id
    )
    langgraph_client = get_client(url=LANGGRAPH_URL)
    await langgraph_client.runs.create(
        thread_id,
        "agent",
        input={"messages": [{"role": "user", "content": prompt}]},
        config={
            "configurable": {
                "source": "github",
                "github_login": github_login,
                "github_user_id": github_user_id,
                "repo": repo_config,
                "pr_number": pr_number,
                "base_branch": base_branch,
            },
            "metadata": _AGENT_VERSION_METADATA,
        },
        if_not_exists="create",
    )
    logger.info("LangGraph run created for thread %s from GitHub PR comment", thread_id)


async def _get_or_resolve_thread_github_token(thread_id: str, email: str) -> str | None:
    """Resolve and persist a GitHub token for a thread when available.

    In bot-token-only mode, returns a fresh GitHub App installation token
    instead of resolving per-user OAuth tokens.
    """
    # Always use GitHub App installation token (per-user OAuth via LangSmith removed)
    bot_token = await get_github_app_installation_token()
    if bot_token:
        try:
            await persist_encrypted_github_token(thread_id, bot_token)
        except Exception:
            logger.warning("Could not persist bot token for thread %s", thread_id)
        return bot_token
    logger.warning("Bot-token-only mode but GitHub App token unavailable")
    return None


async def process_github_pr_comment(payload: dict[str, Any], event_type: str) -> None:
    """Process a GitHub PR comment that tagged @open-swe.

    Retrieves the existing thread token, reacts with 👀, fetches all comments
    since the last @open-swe tag, then creates or queues a new run.

    Args:
        payload: The parsed GitHub webhook payload.
        event_type: One of 'issue_comment', 'pull_request_review_comment',
                    'pull_request_review'.
    """
    (
        repo_config,
        pr_number,
        branch_name,
        github_login,
        pr_url,
        comment_id,
        node_id,
        base_branch,
    ) = await extract_pr_context(payload, event_type)
    github_user_id = payload.get("sender", {}).get("id")

    # Extract base_branch from comment body using LLM if user specified one
    comment_body = payload.get("comment", {}).get("body", "")
    if comment_body:
        llm_base_branch = await extract_base_branch_with_llm(comment_body)
        if llm_base_branch:
            logger.info("LLM extracted base_branch from comment: %s", llm_base_branch)
            base_branch = llm_base_branch

    logger.info(
        "Processing GitHub PR comment: event=%s, pr=%s, branch=%s, base_branch=%s",
        event_type,
        pr_number,
        branch_name,
        base_branch,
    )

    thread_id = get_thread_id_from_branch(branch_name) if branch_name else None
    if not thread_id:
        if not pr_number:
            logger.warning(
                "Could not determine thread_id for branch '%s' (no pr_number), skipping",
                branch_name,
            )
            return
        owner = repo_config.get("owner", "")
        name = repo_config.get("name", "")
        stable_key = f"{owner}/{name}/pr/{pr_number}"
        thread_id = str(uuid.uuid5(uuid.NAMESPACE_URL, stable_key))
        logger.info(
            "Generated thread_id %s for non-open-swe branch '%s'",
            thread_id,
            branch_name,
        )
        langgraph_client = get_client(url=LANGGRAPH_URL)
        thread_metadata = {"branch_name": branch_name}
        if base_branch:
            thread_metadata["base_branch"] = base_branch
        try:
            await langgraph_client.threads.update(thread_id, metadata=thread_metadata)
        except Exception as exc:  # noqa: BLE001
            if _is_not_found_error(exc):
                await langgraph_client.threads.create(
                    thread_id=thread_id,
                    if_exists="do_nothing",
                    metadata=thread_metadata,
                )
            else:
                logger.warning(
                    "Failed to persist branch_name metadata for thread %s", thread_id
                )
    else:
        # Thread already exists - update metadata with base_branch if available
        if base_branch:
            langgraph_client = get_client(url=LANGGRAPH_URL)
            try:
                await langgraph_client.threads.update(
                    thread_id, metadata={"base_branch": base_branch}
                )
            except Exception:
                logger.warning(
                    "Failed to update base_branch metadata for thread %s", thread_id
                )

    email = GITHUB_USER_EMAIL_MAP.get(github_login, "")
    if not email:
        logger.warning("No email mapping for GitHub user '%s', skipping", github_login)
        return

    github_token = await _get_or_resolve_thread_github_token(thread_id, email)
    if not github_token:
        logger.warning("No GitHub token for thread %s, skipping", thread_id)
        return

    if comment_id:
        await react_to_github_comment(
            repo_config,
            comment_id,
            event_type=event_type,
            token=github_token,
            pull_number=pr_number,
            node_id=node_id,
        )

    if not pr_number:
        logger.warning("No PR number found in payload, skipping")
        return

    comments = await fetch_pr_comments_since_last_tag(
        repo_config, pr_number, token=github_token
    )
    if not comments:
        logger.info("No comments found since last @open-swe tag for PR %s", pr_number)
        return

    prompt = build_pr_prompt(comments, pr_url)
    await _trigger_or_queue_run(
        thread_id,
        prompt,
        github_login=github_login,
        github_user_id=github_user_id,
        repo_config=repo_config,
        pr_number=pr_number,
        base_branch=base_branch,
    )


async def process_github_issue(payload: dict[str, Any], event_type: str) -> None:
    """Process a GitHub issue or issue comment that tagged @open-swe."""
    issue = payload.get("issue", {})
    repo = payload.get("repository", {})
    repo_config = {
        "owner": repo.get("owner", {}).get("login", ""),
        "name": repo.get("name", ""),
    }

    issue_id = str(issue.get("id", ""))
    issue_number = issue.get("number")
    github_login = payload.get("sender", {}).get("login", "")
    github_user_id = payload.get("sender", {}).get("id")
    issue_url = issue.get("html_url", "") or issue.get("url", "")
    title = issue.get("title", "No title")
    description = issue.get("body") or "No description"
    issue_author = issue.get("user", {}).get("login", "")

    logger.info(
        "Processing GitHub issue: event=%s, issue=%s, repo=%s/%s",
        event_type,
        issue_number,
        repo_config.get("owner"),
        repo_config.get("name"),
    )

    if not issue_id or not issue_number:
        logger.warning("Missing GitHub issue id/number, skipping")
        return

    email = GITHUB_USER_EMAIL_MAP.get(github_login, "")
    if not email:
        logger.warning("No email mapping for GitHub user '%s', skipping", github_login)
        return

    thread_id = generate_thread_id_from_github_issue(issue_id)
    existing_thread = await _thread_exists(thread_id)
    github_token = await _get_or_resolve_thread_github_token(thread_id, email)
    app_token = await get_github_app_installation_token()
    reaction_token = github_token or app_token
    comment = payload.get("comment", {})
    comment_id = comment.get("id")
    if event_type == "issue_comment" and comment_id:
        if not reaction_token:
            logger.warning(
                "No GitHub token available to react to issue comment %s", comment_id
            )
        else:
            reacted = await react_to_github_comment(
                repo_config,
                comment_id,
                event_type="issue_comment",
                token=reaction_token,
            )
            if not reacted:
                logger.warning("Failed to react to GitHub issue comment %s", comment_id)

    if existing_thread:
        if event_type == "issue_comment":
            prompt = build_github_issue_followup_prompt(
                comment.get("user", {}).get("login", github_login) or github_login,
                comment.get("body", ""),
            )
        else:
            prompt = build_github_issue_update_prompt(github_login, title, description)
    else:
        comments = await fetch_issue_comments(
            repo_config, issue_number, token=github_token or app_token
        )
        if comment_id and not any(
            item.get("comment_id") == comment_id for item in comments
        ):
            comments.append(
                {
                    "body": comment.get("body", ""),
                    "author": comment.get("user", {}).get("login", "unknown"),
                    "created_at": comment.get("created_at", ""),
                    "comment_id": comment_id,
                }
            )
            comments.sort(key=lambda item: item.get("created_at", ""))

        prompt = build_github_issue_prompt(
            repo_config,
            issue_number,
            issue_id,
            title,
            description,
            comments,
            github_login=github_login,
            issue_author=issue_author,
        )
    configurable: dict[str, Any] = {
        "source": "github",
        "github_login": github_login,
        "github_user_id": github_user_id,
        "repo": repo_config,
        "github_issue": {
            "id": issue_id,
            "number": issue_number,
            "title": title,
            "url": issue_url,
        },
    }

    thread_active = await is_thread_active(thread_id)
    if thread_active:
        logger.info("Thread %s is busy, queuing GitHub issue message", thread_id)
        await queue_message_for_thread(thread_id, prompt)
        return

    logger.info("Creating LangGraph run for thread %s from GitHub issue", thread_id)
    langgraph_client = get_client(url=LANGGRAPH_URL)
    await langgraph_client.runs.create(
        thread_id,
        "agent",
        input={"messages": [{"role": "user", "content": prompt}]},
        config={"configurable": configurable, "metadata": _AGENT_VERSION_METADATA},
        if_not_exists="create",
    )
    logger.info("LangGraph run created for thread %s from GitHub issue", thread_id)


@app.post("/webhooks/github")
async def github_webhook(
    request: Request, background_tasks: BackgroundTasks
) -> dict[str, str]:
    """Handle GitHub webhooks for issue and PR events that tag @open-swe."""
    body = await request.body()

    signature = request.headers.get("X-Hub-Signature-256", "")
    if not verify_github_signature(body, signature, secret=GITHUB_WEBHOOK_SECRET):
        logger.warning("Invalid GitHub webhook signature")
        raise HTTPException(status_code=401, detail="Invalid signature")

    event_type = request.headers.get("X-GitHub-Event", "")
    if event_type not in _SUPPORTED_GH_EVENTS:
        logger.info("Ignoring unsupported GitHub event type: %s", event_type)
        return {"status": "ignored", "reason": f"Unsupported event type: {event_type}"}

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        logger.exception("Failed to parse GitHub webhook JSON")
        return {"status": "error", "message": "Invalid JSON"}

    # Check org allowlist
    webhook_repo = payload.get("repository", {})
    webhook_repo_config = {
        "owner": webhook_repo.get("owner", {}).get("login", ""),
        "name": webhook_repo.get("name", ""),
    }
    if not _is_repo_org_allowed(webhook_repo_config):
        logger.warning(
            "Rejecting GitHub webhook: org '%s' not in ALLOWED_GITHUB_ORGS",
            webhook_repo_config.get("owner"),
        )
        return {"status": "ignored", "reason": "Repository org not in allowlist"}

    issue = payload.get("issue", {})
    is_pull_request_comment = bool(
        event_type == "issue_comment" and issue.get("pull_request")
    )
    is_issue_comment = bool(
        event_type == "issue_comment" and not issue.get("pull_request")
    )
    is_issue_event = event_type == "issues"

    if is_issue_event:
        action = payload.get("action", "")
        if action not in _SUPPORTED_GH_ISSUE_ACTIONS:
            logger.info("Ignoring unsupported GitHub issue action: %s", action)
            return {
                "status": "ignored",
                "reason": f"Unsupported GitHub issue action: {action}",
            }
        if action == "edited":
            changes = payload.get("changes", {})
            if not any(field in changes for field in ("body", "title")):
                logger.info("Ignoring GitHub issue edit without title/body changes")
                return {
                    "status": "ignored",
                    "reason": "Issue edit did not change title or body",
                }

        issue_text = f"{issue.get('title', '')}\n\n{issue.get('body', '')}".lower()
        if not any(tag in issue_text for tag in OPEN_SWE_TAGS):
            logger.info("Ignoring issue that does not mention @openswe or @open-swe")
            return {
                "status": "ignored",
                "reason": "Issue does not mention @openswe or @open-swe",
            }

        logger.info("Accepted GitHub issue webhook, scheduling background task")
        background_tasks.add_task(process_github_issue, payload, event_type)
        return {"status": "accepted", "message": "Processing GitHub issue event"}

    comment = payload.get("comment") or payload.get("review", {})
    comment_body = (comment.get("body") or "") if comment else ""
    if not any(tag in comment_body.lower() for tag in OPEN_SWE_TAGS):
        logger.info("Ignoring comment that does not mention @openswe or @open-swe")
        return {
            "status": "ignored",
            "reason": "Comment does not mention @openswe or @open-swe",
        }

    logger.info(
        "Accepted GitHub webhook: event=%s, scheduling background task", event_type
    )
    if is_pull_request_comment or event_type in {
        "pull_request_review_comment",
        "pull_request_review",
    }:
        background_tasks.add_task(process_github_pr_comment, payload, event_type)
        return {"status": "accepted", "message": f"Processing {event_type} event"}

    if is_issue_comment:
        background_tasks.add_task(process_github_issue, payload, event_type)
        return {
            "status": "accepted",
            "message": "Processing GitHub issue comment event",
        }

    logger.info("Ignoring unsupported GitHub payload shape for event=%s", event_type)
    return {
        "status": "ignored",
        "reason": f"Unsupported payload for event type: {event_type}",
    }


async def process_jira_issue(  # noqa: PLR0912, PLR0915
    issue_data: dict[str, Any], repo_config: dict[str, str]
) -> None:
    """Process a Jira issue by creating a new LangGraph thread and run.

    Args:
        issue_data: The Jira issue data from webhook.
        repo_config: The repo configuration with owner and name.
    """
    issue_key = issue_data.get("issue_key", "")
    logger.info(
        "Processing Jira issue %s for repo %s/%s",
        issue_key,
        repo_config.get("owner"),
        repo_config.get("name"),
    )

    thread_id = generate_thread_id_from_jira_issue(issue_key)

    # Fetch full issue details from Jira API
    full_issue_result = await jira_get_issue(issue_key)
    full_issue = (
        full_issue_result.get("issue", {})
        if isinstance(full_issue_result, dict)
        else {}
    )

    user_email = issue_data.get("comment_author_email", "")
    user_name = issue_data.get("comment_author", "")

    # Fallback to issue reporter if no comment author
    if not user_email and full_issue:
        reporter = full_issue.get("fields", {}).get("reporter", {})
        user_email = reporter.get("emailAddress", "")
        user_name = reporter.get("displayName", "")

    logger.info("User email for issue %s: %s", issue_key, user_email)

    # Get issue details
    fields = full_issue.get("fields", {}) if full_issue else {}
    title = issue_data.get("issue_summary") or fields.get("summary", "No title")
    description = issue_data.get("issue_description") or fields.get("description", "")
    if isinstance(description, dict):
        # Handle Atlassian Document Format (ADF)
        description = _extract_text_from_adf(description)
    description = description or "No description"

    image_urls: list[str] = []
    description_image_urls = extract_image_urls(description)
    if description_image_urls:
        image_urls.extend(description_image_urls)
        logger.debug(
            "Found %d image URL(s) in issue description",
            len(description_image_urls),
        )

    # Build comments section
    comments_text = ""
    triggering_comment = issue_data.get("comment_body", "")

    # Extract base_branch from comment using LLM
    base_branch = None
    if triggering_comment:
        base_branch = await extract_base_branch_with_llm(triggering_comment)
        if base_branch:
            logger.info("LLM extracted base_branch from Jira comment: %s", base_branch)

    bot_message_prefixes = (
        "🔐 **GitHub Authentication Required**",
        "✅ **Pull Request Created**",
        "✅ **Pull Request Updated**",
        "**Pull Request Created**",
        "**Pull Request Updated**",
        "🤖 **Agent Response**",
        "❌ **Agent Error**",
    )

    # Include triggering comment if present
    if triggering_comment:
        comments_text = "\n\n## Comments:\n"
        trigger_author = user_name or "Unknown"
        trigger_image_urls = extract_image_urls(triggering_comment)
        if trigger_image_urls:
            image_urls.extend(trigger_image_urls)
            logger.debug(
                "Found %d image URL(s) in triggering comment by %s",
                len(trigger_image_urls),
                trigger_author,
            )
        if not any(
            triggering_comment.startswith(prefix) for prefix in bot_message_prefixes
        ):
            comments_text += f"\n**{trigger_author}:** {triggering_comment}\n"

    issue_url = issue_data.get("issue_url") or (
        f"{full_issue.get('self', '').split('/rest')[0]}/browse/{issue_key}"
        if full_issue
        else ""
    )

    triggered_by_line = f"## Triggered by: {user_name}\n\n" if user_name else ""
    tag_instruction = (
        f"When calling jira_add_comment, tag {user_name} if you are asking them a question, need their input, or are notifying them of something important (e.g. a completed PR). For simple answers, tagging is not required."
        if user_name
        else ""
    )
    prompt = (
        f"Please work on the following issue:\n\n"
        f"## Title: {title}\n\n"
        f"{triggered_by_line}"
        f"## Jira Issue: {issue_key}\n\n"
        f"## Description:\n{description}\n"
        f"{comments_text}\n\n"
        f"Please analyze this issue and implement the necessary changes. "
        f"When you're done, commit and push your changes. {tag_instruction}"
    )
    content_blocks: list[dict[str, Any]] = [create_text_block(prompt)]
    if image_urls:
        image_urls = dedupe_urls(image_urls)
        logger.info("Preparing %d image(s) for multimodal content", len(image_urls))
        logger.debug("Image URLs: %s", image_urls)

        async with httpx.AsyncClient() as client:
            for image_url in image_urls:
                image_block = await fetch_image_block(image_url, client)
                if image_block:
                    content_blocks.append(image_block)
        logger.info("Built %d content block(s) for prompt", len(content_blocks))

    project_key = issue_data.get("project_key", "")
    if not project_key and issue_key:
        # Extract project key from issue key (e.g., "PROJ-123" -> "PROJ")
        project_key = issue_key.split("-")[0] if "-" in issue_key else ""

    configurable: dict[str, Any] = {
        "repo": repo_config,
        "jira_issue": {
            "key": issue_key,
            "title": title,
            "url": issue_url,
            "project_key": project_key,
            "triggering_user_name": user_name or "",
        },
        "user_email": user_email,
        "source": "jira",
    }
    if base_branch:
        configurable["base_branch"] = base_branch

    logger.info("Checking if thread %s is active before creating run", thread_id)
    thread_active = await is_thread_active(thread_id)
    logger.info("Thread %s active status: %s", thread_id, thread_active)

    if thread_active:
        logger.info(
            "Thread %s is active (busy), will queue message instead of creating run",
            thread_id,
        )

        queued_payload = {"text": prompt, "image_urls": image_urls}
        queued = await queue_message_for_thread(
            thread_id=thread_id,
            message_content=queued_payload,
        )

        if queued:
            logger.info(
                "Message queued for thread %s, will be processed by middleware",
                thread_id,
            )
        else:
            logger.error("Failed to queue message for thread %s", thread_id)
    else:
        logger.info("Creating LangGraph run for thread %s", thread_id)
        langgraph_client = get_client(url=LANGGRAPH_URL)

        # Update thread metadata with base_branch if available
        if base_branch:
            try:
                await langgraph_client.threads.update(
                    thread_id, metadata={"base_branch": base_branch}
                )
            except Exception:
                logger.warning(
                    "Failed to update base_branch metadata for thread %s", thread_id
                )

        run = await langgraph_client.runs.create(
            thread_id,
            "agent",
            input={"messages": [{"role": "user", "content": content_blocks}]},
            config={"configurable": configurable, "metadata": _AGENT_VERSION_METADATA},
            if_not_exists="create",
        )
        logger.info("LangGraph run created successfully for thread %s", thread_id)

        # Add a comment to Jira issue with trace info
        trace_url = get_trace_url(run.get("run_id", ""))
        if trace_url:
            await jira_add_comment(
                issue_key,
                f"On it! I'm working on this issue. [View trace]({trace_url})",
            )


def _extract_text_from_adf(adf: dict[str, Any]) -> str:
    """Extract plain text from Atlassian Document Format.

    Args:
        adf: The ADF document structure

    Returns:
        Extracted plain text
    """
    text_parts = []

    def extract_from_node(node: dict[str, Any] | list) -> None:
        if isinstance(node, list):
            for item in node:
                extract_from_node(item)
        elif isinstance(node, dict):
            if node.get("type") == "text":
                text = node.get("text", "")
                if text:
                    text_parts.append(text)
            elif "content" in node:
                extract_from_node(node["content"])

    extract_from_node(adf)
    return "\n".join(text_parts)


@app.post("/webhooks/jira")
async def jira_webhook(
    request: Request, background_tasks: BackgroundTasks
) -> dict[str, str]:
    """Handle Jira Automation webhooks.

    Triggers a new LangGraph run when a Jira issue comment mentions @openswe.
    """
    logger.info("Received Jira webhook")
    body = await request.body()

    # Verify webhook secret
    provided_secret = request.headers.get("X-Jira-Webhook-Secret", "")
    if not verify_jira_webhook_secret(body, JIRA_WEBHOOK_SECRET, provided_secret):
        logger.warning("Invalid webhook secret")
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        logger.exception("Failed to parse webhook JSON")
        return {"status": "error", "message": "Invalid JSON"}

    # Parse and validate payload
    parsed = parse_jira_webhook_payload(payload)
    if not parsed:
        logger.warning("Invalid webhook payload")
        return {"status": "error", "message": "Invalid payload"}

    issue_key = parsed["issue_key"]
    comment_body = parsed["comment_body"]

    # Check for bot mention
    if not jira_contains_bot_mention(comment_body):
        logger.debug("Ignoring webhook: comment doesn't mention @openswe")
        return {"status": "ignored", "reason": "Comment doesn't mention @openswe"}

    # Extract repo config from comment body
    repo_config = jira_extract_repo_from_text(comment_body)
    if not repo_config:
        logger.debug("No repo found in comment body, using default")
        repo_config = {"owner": DEFAULT_REPO_OWNER, "name": DEFAULT_REPO_NAME}

    if not _is_repo_org_allowed(repo_config):
        logger.warning(
            "Rejecting Jira webhook: org '%s' not in ALLOWED_GITHUB_ORGS",
            repo_config.get("owner"),
        )
        return {"status": "ignored", "reason": "Repository org not in allowlist"}

    repo_owner = repo_config["owner"]
    repo_name = repo_config["name"]

    logger.info(
        "Accepted webhook for issue '%s', scheduling background task",
        issue_key,
    )
    background_tasks.add_task(process_jira_issue, parsed, repo_config)

    return {
        "status": "accepted",
        "message": f"Processing issue '{issue_key}' for repo {repo_owner}/{repo_name}",
    }


@app.get("/webhooks/jira")
async def jira_webhook_verify() -> dict[str, str]:
    """Verify endpoint for Jira webhook setup."""
    return {"status": "ok", "message": "Jira webhook endpoint is active"}
