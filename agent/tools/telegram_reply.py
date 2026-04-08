import asyncio
from typing import Any

from langchain_core.tools import tool
from langgraph.config import get_config

from ..utils.telegram import send_telegram_message


@tool
def telegram_reply(message: str) -> dict[str, Any]:
    """Send a message to the current Telegram chat.

    Format messages using Telegram HTML parse mode:
    - <b>bold</b> for bold text
    - <i>italic</i> for italic text
    - <code>code</code> for inline code
    - <pre>code block</pre> for multi-line code blocks
    - <a href="url">link text</a> for hyperlinks
    - Use plain newlines for line breaks.

    Avoid Markdown syntax (**bold**, _italic_, [link](url)) — it will not render.
    Do NOT use HTML entities that break the parser; escape < and > as &lt; and &gt;
    when they appear in plain text (not as HTML tags).

    Args:
        message: The HTML-formatted message to send to the Telegram chat.
    """
    config = get_config()
    configurable = config.get("configurable", {})
    telegram_chat = configurable.get("telegram_chat", {})

    chat_id = telegram_chat.get("chat_id")
    reply_to_message_id = telegram_chat.get("reply_to_message_id")
    message_thread_id = telegram_chat.get("message_thread_id")

    if not chat_id:
        return {
            "success": False,
            "error": "Missing telegram_chat.chat_id in config",
        }

    if not message.strip():
        return {"success": False, "error": "Message cannot be empty"}

    result = asyncio.run(
        send_telegram_message(
            chat_id=chat_id,
            text=message,
            reply_to_message_id=reply_to_message_id,
            message_thread_id=message_thread_id,
            parse_mode="HTML",
        )
    )
    return {"success": result.get("ok", False)}
