"""Tests for OpenSandbox integration.

This module contains both unit tests and integration tests for the OpenSandbox backend.
Integration tests are skipped if OpenSandbox is not running or not configured.
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Skip all tests if opensandbox is not installed
pytest.importorskip("opensandbox", reason="opensandbox not installed")

from agent.integrations.opensandbox import (
    DEFAULT_OPENSANDBOX_TEMPLATE,
    DEFAULT_OPENSANDBOX_TIMEOUT,
    DEFAULT_OPENSANDBOX_URL,
    OpenSandboxBackend,
    _build_sandbox_envs,
    _combine_output,
    _extract_execution_output,
    _parse_server_url,
    _resolve_timeout,
    create_opensandbox_sandbox,
)


def _make_mock_execution(
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 0,
) -> MagicMock:
    """Build a MagicMock shaped like the opensandbox Execution object."""
    result = MagicMock()
    result.exit_code = exit_code
    stdout_msg = MagicMock()
    stdout_msg.text = stdout
    stderr_msg = MagicMock()
    stderr_msg.text = stderr
    result.logs.stdout = [stdout_msg] if stdout else []
    result.logs.stderr = [stderr_msg] if stderr else []
    return result


class TestHelperFunctions:
    """Tests for helper functions."""

    def test_combine_output_with_stdout_and_stderr(self) -> None:
        """Test combining both stdout and stderr."""
        result = _combine_output("hello", "world")
        assert result == "hello\nworld"

    def test_combine_output_with_empty_stderr(self) -> None:
        """Test combining with empty stderr."""
        result = _combine_output("hello", "")
        assert result == "hello"

    def test_combine_output_with_empty_stdout(self) -> None:
        """Test combining with empty stdout."""
        result = _combine_output("", "error")
        assert result == "error"

    def test_combine_output_with_none_stderr(self) -> None:
        """Test combining with None stderr."""
        result = _combine_output("hello", None)  # type: ignore[arg-type]
        assert result == "hello"

    def test_combine_output_with_both_empty(self) -> None:
        """Test combining with both empty."""
        result = _combine_output("", "")
        assert result == ""

    def test_build_sandbox_envs_with_api_key(self) -> None:
        """Test building envs when ANTHROPIC_API_KEY is set."""
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            envs = _build_sandbox_envs()
            assert envs == {"ANTHROPIC_API_KEY": "test-key"}

    def test_build_sandbox_envs_without_api_key(self) -> None:
        """Test building envs when ANTHROPIC_API_KEY is not set."""
        with patch.dict(os.environ, {}, clear=True):
            envs = _build_sandbox_envs()
            assert envs == {}

    def test_resolve_timeout_with_explicit_value(self) -> None:
        """Test resolving timeout with explicit value."""
        assert _resolve_timeout(600) == 600

    def test_resolve_timeout_from_opensandbox_timeout_env(self) -> None:
        """Test resolving timeout from OPENSANDBOX_TIMEOUT env var."""
        with patch.dict(os.environ, {"OPENSANDBOX_TIMEOUT": "600"}):
            assert _resolve_timeout(None) == 600

    def test_resolve_timeout_from_sandbox_timeout_env(self) -> None:
        """Test resolving timeout from SANDBOX_TIMEOUT env var."""
        with patch.dict(os.environ, {"SANDBOX_TIMEOUT": "450"}):
            assert _resolve_timeout(None) == 450

    def test_resolve_timeout_invalid_env_fallback(self) -> None:
        """Test fallback when env var is invalid."""
        with patch.dict(os.environ, {"OPENSANDBOX_TIMEOUT": "invalid"}):
            assert _resolve_timeout(None) == DEFAULT_OPENSANDBOX_TIMEOUT

    def test_resolve_timeout_default(self) -> None:
        """Test default timeout when no env vars set."""
        with patch.dict(os.environ, {}, clear=True):
            assert _resolve_timeout(None) == DEFAULT_OPENSANDBOX_TIMEOUT

    def test_parse_server_url_with_http_url(self) -> None:
        """Test parsing domain from a full HTTP URL."""
        assert _parse_server_url("http://127.0.0.1:9000") == "127.0.0.1:9000"

    def test_parse_server_url_with_localhost(self) -> None:
        """Test parsing domain from localhost URL."""
        assert _parse_server_url("http://localhost:9000") == "localhost:9000"

    def test_extract_execution_output_with_stdout_only(self) -> None:
        """Test extracting stdout from an Execution object."""
        result = _make_mock_execution(stdout="hello", stderr="")
        stdout, stderr = _extract_execution_output(result)
        assert stdout == "hello"
        assert stderr == ""

    def test_extract_execution_output_with_both(self) -> None:
        """Test extracting both stdout and stderr."""
        result = _make_mock_execution(stdout="out", stderr="err")
        stdout, stderr = _extract_execution_output(result)
        assert stdout == "out"
        assert stderr == "err"

    def test_extract_execution_output_empty(self) -> None:
        """Test extracting from an empty Execution object."""
        result = _make_mock_execution()
        stdout, stderr = _extract_execution_output(result)
        assert stdout == ""
        assert stderr == ""


class TestOpenSandboxBackendUnit:
    """Unit tests for OpenSandboxBackend."""

    def _make_backend(self, mock_sandbox: MagicMock) -> OpenSandboxBackend:
        """Create a backend with a pre-configured mock sandbox."""
        with patch.object(OpenSandboxBackend, "_init_sandbox", new_callable=AsyncMock) as mock_init:
            mock_init.return_value = mock_sandbox
            backend = OpenSandboxBackend(
                sandbox_id="test-sandbox-id",
                connection_config=MagicMock(),
            )
        return backend

    def test_id_property_with_id(self) -> None:
        """Test id property when sandbox has id attribute."""
        mock_sandbox = MagicMock()
        mock_sandbox.id = "test-sandbox-123"
        backend = self._make_backend(mock_sandbox)
        assert backend.id == "test-sandbox-123"

    def test_id_property_raises_when_no_id(self) -> None:
        """Test id property raises when no id attribute exists."""
        mock_sandbox = MagicMock()
        mock_sandbox.id = None
        backend = self._make_backend(mock_sandbox)
        with pytest.raises(AttributeError, match="OpenSandbox did not expose an id"):
            _ = backend.id

    @pytest.mark.asyncio
    async def test_execute_success(self) -> None:
        """Test successful command execution."""
        mock_sandbox = MagicMock()
        mock_result = _make_mock_execution(stdout="output", exit_code=0)
        mock_sandbox.commands.run = AsyncMock(return_value=mock_result)

        backend = self._make_backend(mock_sandbox)
        response = backend.execute("echo hello")

        assert response.output == "output"
        assert response.exit_code == 0
        assert response.truncated is False

    @pytest.mark.asyncio
    async def test_execute_with_stderr(self) -> None:
        """Test command execution with stderr output."""
        mock_sandbox = MagicMock()
        mock_result = _make_mock_execution(
            stdout="stdout content", stderr="stderr content", exit_code=0
        )
        mock_sandbox.commands.run = AsyncMock(return_value=mock_result)

        backend = self._make_backend(mock_sandbox)
        response = backend.execute("some command")

        assert response.output == "stdout content\nstderr content"
        assert response.exit_code == 0

    @pytest.mark.asyncio
    async def test_execute_with_error(self) -> None:
        """Test command execution that raises an exception."""
        mock_sandbox = MagicMock()
        mock_sandbox.commands.run = AsyncMock(side_effect=Exception("Command failed"))

        backend = self._make_backend(mock_sandbox)
        response = backend.execute("failing command")

        assert "Command failed" in response.output
        assert response.exit_code == 1
        assert response.truncated is False

    @pytest.mark.asyncio
    async def test_execute_with_nonzero_exit_code(self) -> None:
        """Test command execution with non-zero exit code from Execution result."""
        mock_sandbox = MagicMock()
        mock_result = _make_mock_execution(stderr="error text", exit_code=2)
        mock_sandbox.commands.run = AsyncMock(return_value=mock_result)

        backend = self._make_backend(mock_sandbox)
        response = backend.execute("bad command")

        assert "error text" in response.output
        assert response.exit_code == 2

    @pytest.mark.asyncio
    async def test_write_file_success(self) -> None:
        """Test successful file write."""
        mock_sandbox = MagicMock()
        mock_sandbox.files.write_files = AsyncMock()

        backend = self._make_backend(mock_sandbox)
        result = backend.write("/tmp/test.txt", "content")

        assert result.path == "/tmp/test.txt"
        assert result.error is None

    @pytest.mark.asyncio
    async def test_write_file_failure(self) -> None:
        """Test file write failure."""
        mock_sandbox = MagicMock()
        mock_sandbox.files.write_files = AsyncMock(side_effect=Exception("Write failed"))

        backend = self._make_backend(mock_sandbox)
        result = backend.write("/tmp/test.txt", "content")

        assert result.path == "/tmp/test.txt"
        assert result.error is not None
        assert "Write failed" in result.error

    @pytest.mark.asyncio
    async def test_download_files_success(self) -> None:
        """Test successful file download."""
        mock_sandbox = MagicMock()
        mock_sandbox.files.read_file = AsyncMock(return_value=b"file content")

        backend = self._make_backend(mock_sandbox)
        responses = backend.download_files(["/tmp/file1.txt", "/tmp/file2.txt"])

        assert len(responses) == 2
        for resp in responses:
            assert resp.content == b"file content"
            assert resp.error is None

    @pytest.mark.asyncio
    async def test_download_files_failure(self) -> None:
        """Test file download failure."""
        mock_sandbox = MagicMock()
        mock_sandbox.files.read_file = AsyncMock(side_effect=Exception("Read failed"))

        backend = self._make_backend(mock_sandbox)
        responses = backend.download_files(["/tmp/file.txt"])

        assert len(responses) == 1
        assert responses[0].content is None
        assert "Read failed" in responses[0].error

    @pytest.mark.asyncio
    async def test_upload_files_success(self) -> None:
        """Test successful file upload."""
        mock_sandbox = MagicMock()
        mock_sandbox.files.write_files = AsyncMock()

        backend = self._make_backend(mock_sandbox)
        responses = backend.upload_files([("/tmp/file.txt", b"content")])

        assert len(responses) == 1
        assert responses[0].path == "/tmp/file.txt"
        assert responses[0].error is None

    @pytest.mark.asyncio
    async def test_upload_files_failure(self) -> None:
        """Test file upload failure."""
        mock_sandbox = MagicMock()
        mock_sandbox.files.write_files = AsyncMock(side_effect=Exception("Upload failed"))

        backend = self._make_backend(mock_sandbox)
        responses = backend.upload_files([("/tmp/file.txt", b"content")])

        assert len(responses) == 1
        assert responses[0].path == "/tmp/file.txt"
        assert "Upload failed" in responses[0].error


class TestOpenSandboxIntegration:
    """Integration tests that verify OpenSandbox is actually running.

    These tests are skipped if:
    - OPENSANDBOX_URL is not set and the default (localhost:9000) is not reachable
    - opensandbox-code-interpreter package is not installed
    """

    @pytest.fixture(scope="class")
    def opensandbox_url(self) -> str:
        """Get OpenSandbox URL from environment or use default."""
        return os.environ.get("OPENSANDBOX_URL", DEFAULT_OPENSANDBOX_URL)

    @pytest.fixture(scope="class")
    def is_opensandbox_available(self, opensandbox_url: str) -> bool:
        """Check if OpenSandbox is available."""
        import urllib.request

        try:
            # Try to connect to OpenSandbox health endpoint
            req = urllib.request.Request(
                f"{opensandbox_url}/health",
                method="GET",
                headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status == 200
        except Exception:
            # If health endpoint doesn't exist, try a basic connection
            try:
                import socket

                parsed = opensandbox_url.replace("http://", "").replace("https://", "")
                host = parsed.split(":")[0] if ":" in parsed else parsed
                port = int(parsed.split(":")[1]) if ":" in parsed else 80
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(2)
                result = sock.connect_ex((host, port))
                sock.close()
                return result == 0
            except Exception:
                return False

    @pytest.mark.skipif(
        not os.environ.get("OPENSANDBOX_URL") and not os.environ.get("RUN_INTEGRATION_TESTS"),
        reason="OpenSandbox integration test skipped. Set OPENSANDBOX_URL or RUN_INTEGRATION_TESTS to run.",
    )
    def test_create_sandbox_and_execute_command(self, is_opensandbox_available: bool) -> None:
        """Test creating a sandbox and executing a command."""
        if not is_opensandbox_available:
            pytest.skip("OpenSandbox is not available at the configured URL")

        # Create a new sandbox
        backend = create_opensandbox_sandbox()
        assert backend.id is not None

        try:
            # Execute a simple command
            response = backend.execute("echo 'Hello from OpenSandbox'")
            assert response.exit_code == 0
            assert "Hello from OpenSandbox" in response.output

            # Execute a command with stderr
            response = backend.execute("echo 'error' >&2")
            assert response.exit_code == 0
            assert "error" in response.output
        finally:
            # Cleanup: kill the sandbox
            import asyncio  # noqa: I001
            from opensandbox import Sandbox  # noqa: I001

            async def _kill() -> None:
                from opensandbox.config import ConnectionConfig

                sandbox_url = os.environ.get("OPENSANDBOX_URL", DEFAULT_OPENSANDBOX_URL)
                domain = sandbox_url.replace("http://", "").replace("https://", "")
                cfg = ConnectionConfig(domain=domain, use_server_proxy=True)
                sandbox = await Sandbox.connect(backend.id, connection_config=cfg)
                await sandbox.kill()

            try:
                asyncio.run(_kill())
            except Exception as e:
                print(f"Warning: Failed to cleanup sandbox: {e}")

    @pytest.mark.skipif(
        not os.environ.get("OPENSANDBOX_URL") and not os.environ.get("RUN_INTEGRATION_TESTS"),
        reason="OpenSandbox integration test skipped. Set OPENSANDBOX_URL or RUN_INTEGRATION_TESTS to run.",
    )
    def test_write_and_read_file(self, is_opensandbox_available: bool) -> None:
        """Test writing and reading files."""
        if not is_opensandbox_available:
            pytest.skip("OpenSandbox is not available at the configured URL")

        backend = create_opensandbox_sandbox()
        assert backend.id is not None

        try:
            # Write a file
            write_result = backend.write("/tmp/test_file.txt", "Hello World")
            assert write_result.error is None

            # Download the file
            responses = backend.download_files(["/tmp/test_file.txt"])
            assert len(responses) == 1
            assert responses[0].error is None
            assert b"Hello World" in responses[0].content

            # Upload multiple files
            upload_responses = backend.upload_files(
                [
                    ("/tmp/upload1.txt", b"content1"),
                    ("/tmp/upload2.txt", b"content2"),
                ]
            )
            assert len(upload_responses) == 2
            for resp in upload_responses:
                assert resp.error is None

            # Verify files exist by reading them
            responses = backend.download_files(["/tmp/upload1.txt", "/tmp/upload2.txt"])
            assert len(responses) == 2
            contents = [r.content for r in responses if r.error is None]
            assert len(contents) == 2
        finally:
            # Cleanup
            import asyncio  # noqa: I001
            from opensandbox import Sandbox  # noqa: I001

            async def _kill() -> None:
                from opensandbox.config import ConnectionConfig

                sandbox_url = os.environ.get("OPENSANDBOX_URL", DEFAULT_OPENSANDBOX_URL)
                domain = sandbox_url.replace("http://", "").replace("https://", "")
                cfg = ConnectionConfig(domain=domain, use_server_proxy=True)
                sandbox = await Sandbox.connect(backend.id, connection_config=cfg)
                await sandbox.kill()

            try:
                asyncio.run(_kill())
            except Exception as e:
                print(f"Warning: Failed to cleanup sandbox: {e}")

    @pytest.mark.skipif(
        not os.environ.get("OPENSANDBOX_URL") and not os.environ.get("RUN_INTEGRATION_TESTS"),
        reason="OpenSandbox integration test skipped. Set OPENSANDBOX_URL or RUN_INTEGRATION_TESTS to run.",
    )
    def test_reconnect_to_existing_sandbox(self, is_opensandbox_available: bool) -> None:
        """Test reconnecting to an existing sandbox."""
        if not is_opensandbox_available:
            pytest.skip("OpenSandbox is not available at the configured URL")

        # Create initial sandbox
        backend1 = create_opensandbox_sandbox()
        original_id = backend1.id

        try:
            # Reconnect to the same sandbox
            backend2 = create_opensandbox_sandbox(sandbox_id=original_id)
            assert backend2.id == original_id

            # Verify we can execute commands on reconnected sandbox
            response = backend2.execute("echo 'reconnected'")
            assert response.exit_code == 0
        finally:
            # Cleanup
            import asyncio  # noqa: I001
            from opensandbox import Sandbox  # noqa: I001

            async def _kill() -> None:
                from opensandbox.config import ConnectionConfig

                sandbox_url = os.environ.get("OPENSANDBOX_URL", DEFAULT_OPENSANDBOX_URL)
                domain = sandbox_url.replace("http://", "").replace("https://", "")
                cfg = ConnectionConfig(domain=domain, use_server_proxy=True)
                sandbox = await Sandbox.connect(original_id, connection_config=cfg)
                await sandbox.kill()

            try:
                asyncio.run(_kill())
            except Exception as e:
                print(f"Warning: Failed to cleanup sandbox: {e}")


class TestOpenSandboxConfiguration:
    """Tests for OpenSandbox configuration."""

    def test_default_template(self) -> None:
        """Test default template constant."""
        assert (
            DEFAULT_OPENSANDBOX_TEMPLATE
            == "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2"
        )

    def test_default_url(self) -> None:
        """Test default URL constant."""
        assert DEFAULT_OPENSANDBOX_URL == "http://localhost:9000"

    def test_default_timeout(self) -> None:
        """Test default timeout constant."""
        assert DEFAULT_OPENSANDBOX_TIMEOUT == 300

    def test_create_sandbox_raises_import_error(self) -> None:
        """Test that create_opensandbox_sandbox raises ImportError when package not installed."""
        # Patch the import to raise ImportError
        with patch.dict("sys.modules", {"opensandbox": None}):
            with pytest.raises(
                ImportError,
                match="opensandbox-code-interpreter|uv sync --extra opensandbox",
            ):
                create_opensandbox_sandbox()
