"""Text extraction utilities using LLM."""

from __future__ import annotations

import json
import logging
import os

import httpx

logger = logging.getLogger(__name__)

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
EXTRACTION_MODEL = "minimax-m2.7:cloud"


async def extract_base_branch_with_llm(text: str) -> str | None:
    """Extract target base branch from text using LLM.

    Uses minimax-m2.7:cloud model from Ollama to intelligently extract
    the target base branch mentioned in the message.

    Args:
        text: The message text to analyze

    Returns:
        The base branch name if found, None otherwise
    """
    if not text or not text.strip():
        return None

    prompt = f"""Extract the target base branch from the following message.
If the user mentions a target branch, base branch, or branch to merge into, return it.
Otherwise return null.

Message: {text}

Respond in JSON format: {{"base_branch": string | null}}"""

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json={
                    "model": EXTRACTION_MODEL,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                },
            )
            response.raise_for_status()
            data = response.json()

            response_text = data.get("response", "").strip()
            if not response_text:
                logger.debug("LLM returned empty response for base_branch extraction")
                return None

            # Parse the JSON response
            try:
                result = json.loads(response_text)
                base_branch = result.get("base_branch")
                if base_branch and isinstance(base_branch, str) and base_branch.strip():
                    logger.info("LLM extracted base_branch: %s", base_branch)
                    return base_branch.strip()
            except json.JSONDecodeError:
                logger.warning("LLM returned invalid JSON: %s", response_text)
                return None

    except httpx.TimeoutException:
        logger.warning("Timeout calling Ollama for base_branch extraction")
    except httpx.HTTPError as e:
        logger.warning("HTTP error calling Ollama: %s", e)
    except Exception:
        logger.exception("Error extracting base_branch with LLM")

    return None
