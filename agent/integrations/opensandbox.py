"""OpenSandbox backend implementation."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
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

DEFAULT_OPENSANDBOX_TEMPLATE = (
    "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2"
)
DEFAULT_OPENSANDBOX_TIMEOUT = 300
DEFAULT_OPENSANDBOX_URL = "http://localhost:9000"
ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"


def _combine_output(stdout: Any, stderr: Any) -> str:
    parts = [str(part) for part in (stdout, stderr) if part]
    return "\n".join(parts)


def _extract_execution_output(result: Any) -> tuple[str, str]:
    """Extract stdout and stderr text from an opensandbox Execution object."""
    stdout_msgs = getattr(getattr(result, "logs", None), "stdout", [])
    stderr_msgs = getattr(getattr(result, "logs", None), "stderr", [])
    stdout = "".join(getattr(m, "text", "") for m in stdout_msgs)
    stderr = "".join(getattr(m, "text", "") for m in stderr_msgs)
    return stdout, stderr


def _parse_server_url(server_url: str) -> str:
    """Extract domain (host:port) from a server URL for use in ConnectionConfig."""
    from urllib.parse import urlparse

    parsed = urlparse(server_url)
    return parsed.netloc or server_url.replace("http://", "").replace("https://", "")


def _check_server_reachable(server_url: str) -> None:
    """Verify the OpenSandbox server is reachable via a quick TCP probe.

    Raises:
        ConnectionError: If the server cannot be reached, with a clear message
            that includes the configured URL and instructions to fix it.
    """
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(server_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 9000
    try:
        with socket.create_connection((host, port), timeout=3):
            pass
    except OSError as exc:
        raise ConnectionError(
            f"OpenSandbox server is not reachable at {server_url} "
            f"(host={host}, port={port}). "
            "Ensure the server is running and OPENSANDBOX_URL is set correctly. "
            f"Original error: {exc}"
        ) from exc


def _build_sandbox_envs() -> dict[str, str]:
    api_key = os.environ.get(ANTHROPIC_API_KEY_ENV)
    if not api_key:
        return {}
    return {ANTHROPIC_API_KEY_ENV: api_key}


def _resolve_timeout(timeout: int | None) -> int:
    if timeout is not None:
        return timeout
    env_timeout = os.environ.get("OPENSANDBOX_TIMEOUT") or os.environ.get("SANDBOX_TIMEOUT")
    if env_timeout:
        try:
            return int(env_timeout)
        except ValueError:
            logger.warning(
                "Invalid OPENSANDBOX_TIMEOUT=%r, falling back to %s",
                env_timeout,
                DEFAULT_OPENSANDBOX_TIMEOUT,
            )
    return DEFAULT_OPENSANDBOX_TIMEOUT


class OpenSandboxBackend(BaseSandbox):
    """OpenSandbox backend implementation conforming to SandboxBackendProtocol.

    All async operations (including sandbox creation/connection) run in a single
    dedicated background event loop so that the SDK's internal httpx transports
    are always used on the loop they were created on, preventing "Event loop is
    closed" errors from cross-loop transport cleanup.
    """

    def __init__(
        self,
        *,
        sandbox_id: str | None = None,
        connection_config: Any,
        create_kwargs: dict[str, Any] | None = None,
        default_timeout: int = DEFAULT_OPENSANDBOX_TIMEOUT,
    ) -> None:
        self._connection_config = connection_config
        self._default_timeout = default_timeout
        # Start a dedicated background event loop.  All SDK calls (including the
        # ones that create httpx transports) happen on this loop.
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._loop_thread.start()
        # Create or reconnect to the sandbox inside the dedicated loop.
        self._sandbox = asyncio.run_coroutine_threadsafe(
            self._init_sandbox(sandbox_id, create_kwargs or {}),
            self._loop,
        ).result()

    async def _init_sandbox(self, sandbox_id: str | None, create_kwargs: dict[str, Any]) -> Any:
        from opensandbox import Sandbox

        if sandbox_id:
            return await Sandbox.connect(sandbox_id, connection_config=self._connection_config)
        return await Sandbox.create(connection_config=self._connection_config, **create_kwargs)

    def _run_async(self, coro: Any) -> Any:
        """Submit a coroutine to the dedicated background event loop and block."""
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result()

    @property
    def id(self) -> str:
        sandbox_id = getattr(self._sandbox, "id", None)
        if not sandbox_id:
            msg = "OpenSandbox did not expose an id"
            raise AttributeError(msg)
        return sandbox_id

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        effective_timeout = timeout if timeout is not None else self._default_timeout

        async def _execute() -> ExecuteResponse:
            from datetime import timedelta

            from opensandbox.models.execd import RunCommandOpts

            opts = RunCommandOpts(timeout=timedelta(seconds=effective_timeout))
            try:
                result = await self._sandbox.commands.run(command, opts=opts)
            except Exception as exc:
                return ExecuteResponse(output=str(exc), exit_code=1, truncated=False)

            stdout, stderr = _extract_execution_output(result)
            output = _combine_output(stdout, stderr)
            exit_code = getattr(result, "exit_code", None)
            if exit_code is None:
                exit_code = 0
            return ExecuteResponse(
                output=output,
                exit_code=exit_code,
                truncated=False,
            )

        return self._run_async(_execute())

    def write(self, file_path: str, content: str) -> WriteResult:
        """Write content using the OpenSandbox SDK to avoid ARG_MAX."""
        try:

            async def _write() -> WriteResult:
                from opensandbox.models import WriteEntry

                entry = WriteEntry(path=file_path, data=content.encode("utf-8"), mode=644)
                await self._sandbox.files.write_files([entry])
                return WriteResult(path=file_path, files_update=None)

            return self._run_async(_write())
        except Exception as exc:
            return WriteResult(path=file_path, error=f"Failed to write file '{file_path}': {exc}")

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        """Download multiple files from the OpenSandbox sandbox."""

        async def _download() -> list[FileDownloadResponse]:
            responses: list[FileDownloadResponse] = []
            for path in paths:
                try:
                    content = await self._sandbox.files.read_file(path)
                    # SDK may return str or bytes; protocol expects bytes.
                    if isinstance(content, str):
                        content = content.encode("utf-8")
                    responses.append(FileDownloadResponse(path=path, content=content, error=None))
                except Exception as exc:
                    responses.append(FileDownloadResponse(path=path, content=None, error=str(exc)))
            return responses

        return self._run_async(_download())

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        """Upload multiple files to the OpenSandbox sandbox."""

        async def _upload() -> list[FileUploadResponse]:
            from opensandbox.models import WriteEntry

            responses: list[FileUploadResponse] = []
            entries = [WriteEntry(path=path, data=data, mode=644) for path, data in files]
            try:
                await self._sandbox.files.write_files(entries)
                for path, _ in files:
                    responses.append(FileUploadResponse(path=path, error=None))
            except Exception as exc:
                for path, _ in files:
                    responses.append(FileUploadResponse(path=path, error=str(exc)))
            return responses

        return self._run_async(_upload())


def _update_thread_sandbox_metadata(sandbox_id: str) -> None:
    """Update thread metadata with sandbox_id."""
    try:
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


def create_opensandbox_sandbox(
    sandbox_id: str | None = None,
    timeout: int | None = None,
) -> SandboxBackendProtocol:
    """Create or connect to an OpenSandbox sandbox.

    Args:
        sandbox_id: Optional existing sandbox ID to reconnect to.
        timeout: Optional timeout for the sandbox lease in seconds.

    Returns:
        An OpenSandbox backend implementing SandboxBackendProtocol.

    Raises:
        ImportError: If opensandbox-code-interpreter is not installed.
        ValueError: If required environment variables are not set.
    """
    try:
        from datetime import timedelta

        from opensandbox.config import ConnectionConfig
    except ImportError as exc:
        raise ImportError(
            "OpenSandbox requires the 'opensandbox-code-interpreter' package. "
            "Install it with: uv sync --extra opensandbox "
            "or uv pip install 'opensandbox-code-interpreter'"
        ) from exc

    template = os.environ.get("OPENSANDBOX_TEMPLATE", DEFAULT_OPENSANDBOX_TEMPLATE)
    envs = _build_sandbox_envs()
    resolved_timeout = _resolve_timeout(timeout)
    server_url = os.environ.get("OPENSANDBOX_URL", DEFAULT_OPENSANDBOX_URL)

    # Fail fast with a clear message before spinning up the background loop.
    _check_server_reachable(server_url)

    # Build connection config: extract domain from server_url and enable server proxy
    # so execd requests are routed through the sandbox server (needed for Docker setups
    # where the client cannot reach the sandbox container directly).
    domain = _parse_server_url(server_url) if server_url else None
    connection_config = ConnectionConfig(domain=domain, use_server_proxy=True)

    create_kwargs: dict[str, Any] | None = None
    if not sandbox_id:
        from opensandbox.models.sandboxes import NetworkPolicy

        # By default, do NOT attach the egress sidecar (network_policy=None).
        # Without a sidecar the sandbox uses plain Docker bridge networking, which
        # provides full outbound internet access via Docker's built-in NAT — this
        # is required for the agent to browse the web, install packages, and use
        # Playwright.  The egress sidecar intercepts DNS via iptables and can break
        # browser/playwright connections even in allow-all mode.
        #
        # Set OPENSANDBOX_DENY_EGRESS=true to attach the sidecar with a deny-all
        # egress policy (requires [egress] image to be configured in ~/.sandbox.toml
        # and docker.network_mode = "bridge").
        deny_egress = os.environ.get("OPENSANDBOX_DENY_EGRESS", "").lower() in (
            "1",
            "true",
            "yes",
        )
        network_policy: NetworkPolicy | None = (
            NetworkPolicy(default_action="deny") if deny_egress else None
        )

        create_kwargs = {
            "image": template,
            "timeout": timedelta(seconds=resolved_timeout),
            "network_policy": network_policy,
        }
        if envs:
            create_kwargs["env"] = envs

    backend = OpenSandboxBackend(
        sandbox_id=sandbox_id,
        connection_config=connection_config,
        create_kwargs=create_kwargs,
        default_timeout=resolved_timeout,
    )
    _update_thread_sandbox_metadata(backend.id)
    return backend
