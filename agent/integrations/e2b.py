"""E2B sandbox backend implementation."""

from __future__ import annotations

import logging
import os
from typing import Any

from deepagents.backends.protocol import (
    ExecuteResponse,
    FileDownloadResponse,
    FileUploadResponse,
    SandboxBackendProtocol,
    WriteResult,
)
from deepagents.backends.sandbox import BaseSandbox

logger = logging.getLogger(__name__)

DEFAULT_E2B_TEMPLATE = "opencode"
DEFAULT_E2B_TIMEOUT = 300
ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"


def _combine_output(stdout: Any, stderr: Any) -> str:
    parts = [str(part) for part in (stdout, stderr) if part]
    return "\n".join(parts)


def _build_sandbox_envs() -> dict[str, str]:
    api_key = os.environ.get(ANTHROPIC_API_KEY_ENV)
    if not api_key:
        return {}
    return {ANTHROPIC_API_KEY_ENV: api_key}


def _resolve_timeout(timeout: int | None) -> int:
    if timeout is not None:
        return timeout
    env_timeout = os.environ.get("SANDBOX_TIMEOUT")
    if env_timeout:
        try:
            return int(env_timeout)
        except ValueError:
            logger.warning(
                "Invalid SANDBOX_TIMEOUT=%r, falling back to %s",
                env_timeout,
                DEFAULT_E2B_TIMEOUT,
            )
    return DEFAULT_E2B_TIMEOUT


class E2BBackend(BaseSandbox):
    """E2B backend implementation conforming to SandboxBackendProtocol."""

    def __init__(self, sandbox: Any) -> None:
        self._sandbox = sandbox
        self._default_timeout = DEFAULT_E2B_TIMEOUT

    @property
    def id(self) -> str:
        sandbox_id = getattr(self._sandbox, "sandbox_id", None)
        if not sandbox_id:
            sandbox_id = getattr(self._sandbox, "id", None)
        if not sandbox_id:
            msg = "E2B sandbox did not expose an id"
            raise AttributeError(msg)
        return sandbox_id

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        effective_timeout = timeout if timeout is not None else self._default_timeout
        try:
            result = self._sandbox.commands.run(command, timeout=effective_timeout)
        except Exception as exc:
            exit_code = getattr(exc, "exit_code", None)
            if exit_code is None:
                raise
            output = _combine_output(getattr(exc, "stdout", ""), getattr(exc, "stderr", ""))
            if not output:
                output = str(exc)
            return ExecuteResponse(output=output, exit_code=exit_code, truncated=False)

        output = _combine_output(getattr(result, "stdout", ""), getattr(result, "stderr", ""))
        return ExecuteResponse(
            output=output,
            exit_code=getattr(result, "exit_code", 0),
            truncated=False,
        )

    def write(self, file_path: str, content: str) -> WriteResult:
        try:
            self._sandbox.files.write(file_path, content)
            return WriteResult(path=file_path, files_update=None)
        except Exception as exc:
            return WriteResult(error=f"Failed to write file '{file_path}': {exc}")

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        for path in paths:
            try:
                content = self._sandbox.files.read(path)
                responses.append(FileDownloadResponse(path=path, content=content, error=None))
            except Exception as exc:
                responses.append(FileDownloadResponse(path=path, content="", error=str(exc)))
        return responses

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        for path, content in files:
            try:
                self._sandbox.files.write(path, content)
                responses.append(FileUploadResponse(path=path, error=None))
            except Exception as exc:
                responses.append(FileUploadResponse(path=path, error=str(exc)))
        return responses


def _update_thread_sandbox_metadata(sandbox_id: str) -> None:
    """Update thread metadata with sandbox_id."""
    try:
        import asyncio

        from langgraph.config import get_config
        from langgraph_sdk import get_client

        config = get_config()
        thread_id = config.get("configurable", {}).get("thread_id")
        if not thread_id:
            return
        client = get_client()

        async def _update() -> None:
            await client.threads.update(
                thread_id=thread_id,
                metadata={"sandbox_id": sandbox_id},
            )

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(_update())
        else:
            loop.create_task(_update())
    except Exception:
        pass


def create_e2b_sandbox(
    sandbox_id: str | None = None,
    timeout: int | None = None,
) -> SandboxBackendProtocol:
    """Create or connect to an E2B sandbox."""
    try:
        from e2b import Sandbox
    except ImportError as exc:
        raise ImportError("e2b is not installed. Please run `uv sync --all-extras`.") from exc

    template = os.environ.get("E2B_TEMPLATE", DEFAULT_E2B_TEMPLATE)
    envs = _build_sandbox_envs()
    resolved_timeout = _resolve_timeout(timeout)
    api_key = os.environ.get("E2B_API_KEY")

    if sandbox_id:
        sandbox = Sandbox.connect(sandbox_id)
        if hasattr(sandbox, "set_timeout"):
            sandbox.set_timeout(resolved_timeout)
    else:
        kwargs: dict[str, Any] = {"template": template, "timeout": resolved_timeout}
        if api_key:
            kwargs["api_key"] = api_key
        if envs:
            kwargs["envs"] = envs
        sandbox = Sandbox.create(**kwargs)

    _update_thread_sandbox_metadata(sandbox.sandbox_id)
    return E2BBackend(sandbox)
