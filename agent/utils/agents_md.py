"""Helpers for reading agent instructions from AGENTS.md."""

from __future__ import annotations

import asyncio
import logging
import shlex

from deepagents.backends.protocol import SandboxBackendProtocol

logger = logging.getLogger(__name__)


async def read_agents_md_in_sandbox(
    sandbox_backend: SandboxBackendProtocol,
    repo_dir: str | None,
) -> tuple[str | None, str]:
    """Read CLAUDE.md or AGENTS.md from the repo root if it exists.

    Returns a tuple of (content, filename) where filename is the file that
    was found ("CLAUDE.md", "AGENTS.md", or "" if neither exists).
    """
    if not repo_dir:
        return None, ""

    loop = asyncio.get_event_loop()

    # First try CLAUDE.md, then fall back to AGENTS.md
    for filename in ["CLAUDE.md", "AGENTS.md"]:
        safe_path = shlex.quote(f"{repo_dir}/{filename}")
        result = await loop.run_in_executor(
            None,
            sandbox_backend.execute,
            f"test -f {safe_path} && cat {safe_path}",
        )
        if result.exit_code == 0:
            content = result.output or ""
            content = content.strip()
            if content:
                logger.debug("Found %s in repo", filename)
                return content, filename

    logger.debug("No CLAUDE.md or AGENTS.md found in %s", repo_dir)
    return None, ""
