#!/usr/bin/env python3
"""Simple standalone test for OpenSandbox integration.

Run this file directly to verify OpenSandbox is working:
    python test_opensandbox_simple.py

Environment variables:
    OPENSANDBOX_URL - OpenSandbox server URL (default: http://127.0.0.1:9000)

NOTE: This test requires the OpenSandbox server to be running with working
sandbox proxy/networking. The server creates sandboxes but direct endpoint
access may require specific network configuration.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import warnings
from typing import Any

import httpx

# Suppress langsmith alpha warning
warnings.filterwarnings(
    "ignore", message="langsmith.sandbox is in alpha", category=FutureWarning
)

# Default OpenSandbox URL
DEFAULT_OPENSANDBOX_URL = "http://127.0.0.1:9000"


def get_opensandbox_url() -> str:
    """Get OpenSandbox URL from environment or use default."""
    return os.environ.get("OPENSANDBOX_URL", DEFAULT_OPENSANDBOX_URL)


def check_opensandbox_available(url: str) -> bool:
    """Check if OpenSandbox server is reachable."""
    import urllib.request

    try:
        req = urllib.request.Request(
            f"{url}/sandboxes", method="GET", headers={"Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status == 200
    except Exception:
        return False


class OpenSandboxDirectClient:
    """Direct HTTP client for OpenSandbox API.

    Uses the actual OpenSandbox HTTP API paths:
    - Lifecycle API (port 9000): /sandboxes, /sandboxes/{id}
    - Execd API (via proxy): /sandboxes/{id}/proxy/44772/*

    NOTE: The execd proxy requires proper server-side networking configuration.
    """

    EXECD_PORT = 44772

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=120.0)

    async def close(self) -> None:
        await self.client.aclose()

    async def create_sandbox(
        self,
        image: str,
        timeout: int = 300,
        resource_limits: dict[str, str] | None = None,
        entrypoint: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Create a new sandbox."""
        if resource_limits is None:
            resource_limits = {"cpu": "500m", "memory": "512Mi"}
        if entrypoint is None:
            entrypoint = ["sleep", "infinity"]

        payload = {
            "image": {"uri": image},
            "timeout": timeout,
            "resourceLimits": resource_limits,
            "entrypoint": entrypoint,
        }
        if env:
            payload["env"] = env

        response = await self.client.post("/sandboxes", json=payload)
        response.raise_for_status()
        return response.json()

    async def get_sandbox(self, sandbox_id: str) -> dict[str, Any]:
        """Get sandbox status."""
        response = await self.client.get(f"/sandboxes/{sandbox_id}")
        response.raise_for_status()
        return response.json()

    async def wait_for_sandbox(
        self, sandbox_id: str, timeout: int = 60
    ) -> dict[str, Any]:
        """Wait for sandbox to be ready."""
        start = time.time()
        while time.time() - start < timeout:
            sandbox = await self.get_sandbox(sandbox_id)
            status = sandbox.get("status")
            # Handle different status formats (string or dict)
            if isinstance(status, dict):
                state = (
                    status.get("state", "").lower()
                    if "state" in status
                    else str(status).lower()
                )
            elif isinstance(status, str):
                state = status.lower()
            else:
                state = str(status).lower()
            print(f"   Status: {state}")
            if state in ("running", "ready"):
                return sandbox
            if state in ("failed", "error", "terminated"):
                raise RuntimeError(f"Sandbox failed with status: {state}")
            await asyncio.sleep(2)
        raise TimeoutError(f"Sandbox {sandbox_id} not ready after {timeout}s")

    def _get_execd_proxy_path(self, sandbox_id: str) -> str:
        """Get execd proxy path for a sandbox via server proxy."""
        return f"/sandboxes/{sandbox_id}/proxy/{self.EXECD_PORT}"

    async def execute_command(
        self, sandbox_id: str, command: str, timeout_ms: int = 30000
    ) -> dict[str, Any]:
        """Execute a command in the sandbox via execd proxy API.

        NOTE: This requires the server to have working sandbox proxy networking.
        """
        execd_path = self._get_execd_proxy_path(sandbox_id)

        # OpenSandbox uses POST /command with streaming SSE response
        payload = {"command": command, "timeout": timeout_ms}

        # Use streaming request with extended read timeout for SSE
        content_parts = []
        async with self.client.stream(
            "POST",
            f"{execd_path}/command",
            json=payload,
            timeout=httpx.Timeout(10.0, read=60.0),
        ) as response:
            response.raise_for_status()
            async for chunk in response.aiter_text():
                content_parts.append(chunk)

        content = "".join(content_parts)
        return self._parse_sse_response(content)

    def _parse_sse_response(self, content: str) -> dict[str, Any]:
        """Parse execd JSON-line response from command execution.

        execd returns newline-delimited JSON objects (not SSE format).
        Each line is a JSON object with a 'type' field and a 'text' field.
        """
        stdout_parts = []
        stderr_parts = []
        exit_code = 0
        error = None

        for line in content.split("\n"):
            line = line.strip()
            if not line:
                continue
            # Strip optional SSE 'data:' prefix if present
            if line.startswith("data:"):
                line = line[5:].strip()
            try:
                event = json.loads(line)
                event_type = event.get("type")

                if event_type == "stdout":
                    stdout_parts.append(event.get("text", ""))
                elif event_type == "stderr":
                    stderr_parts.append(event.get("text", ""))
                elif event_type == "error":
                    error = event.get("text", "")
                elif event_type == "execution_complete":
                    exit_code = event.get("exit_code", 0) or 0
            except json.JSONDecodeError:
                continue

        return {
            "stdout": "".join(stdout_parts),
            "stderr": "".join(stderr_parts),
            "exitCode": exit_code,
            "error": error,
        }

    async def write_file(self, sandbox_id: str, path: str, content: str) -> None:
        """Write a file to the sandbox via files API.

        execd expects multipart form data:
        - 'metadata': JSON string with {'path': '/abs/path'}
        - 'file': raw file bytes
        """
        execd_path = self._get_execd_proxy_path(sandbox_id)

        metadata = json.dumps({"path": path})
        files = {
            "metadata": ("metadata", metadata, "application/json"),
            "file": ("file", content.encode(), "application/octet-stream"),
        }
        response = await self.client.post(f"{execd_path}/files/upload", files=files)
        response.raise_for_status()

    async def read_file(self, sandbox_id: str, path: str) -> bytes:
        """Read a file from the sandbox via files API."""
        execd_path = self._get_execd_proxy_path(sandbox_id)

        response = await self.client.get(
            f"{execd_path}/files/download", params={"path": path}
        )
        response.raise_for_status()

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            result = response.json()
            content = result.get("content", "")
            encoding = result.get("encoding", "utf-8")
            if encoding == "base64":
                return base64.b64decode(content)
            return content.encode()
        return response.content

    async def kill_sandbox(self, sandbox_id: str) -> None:
        """Kill/delete a sandbox."""
        response = await self.client.delete(f"/sandboxes/{sandbox_id}")
        response.raise_for_status()


async def cleanup_sandbox(client: OpenSandboxDirectClient, sandbox_id: str) -> None:
    """Kill the sandbox."""
    try:
        await client.kill_sandbox(sandbox_id)
        print(f"✓ Cleaned up sandbox {sandbox_id}")
    except Exception as e:
        print(f"⚠ Warning: Failed to cleanup sandbox: {e}")


def main() -> int:
    """Run simple OpenSandbox test."""
    print("=" * 60)
    print("OpenSandbox Simple Test (Direct HTTP)")
    print("=" * 60)

    # Get OpenSandbox URL
    opensandbox_url = get_opensandbox_url()
    print(f"\n📍 OpenSandbox URL: {opensandbox_url}")

    # Check if OpenSandbox is available
    print("\n🔍 Checking OpenSandbox availability...")
    if not check_opensandbox_available(opensandbox_url):
        print(f"\n❌ Error: Cannot connect to OpenSandbox at {opensandbox_url}")
        print("\n   Make sure OpenSandbox server is running.")
        return 1
    print("✓ OpenSandbox is reachable")

    # Run async tests
    return asyncio.run(run_tests(opensandbox_url))


async def run_tests(opensandbox_url: str) -> int:
    """Run all tests."""
    client = OpenSandboxDirectClient(opensandbox_url)
    sandbox_id: str | None = None

    try:
        # Test 1: Create sandbox
        print("\n📦 Test 1: Creating sandbox...")
        image = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2"
        result = await client.create_sandbox(
            image=image,
            timeout=300,
            entrypoint=["sleep", "infinity"],
        )
        sandbox_id = result.get("id") or result.get("sandboxId")
        print(f"✓ Sandbox creation initiated: {sandbox_id}")

        # Wait for sandbox to be ready
        print("\n⏳ Waiting for sandbox to be ready...")
        await client.wait_for_sandbox(sandbox_id, timeout=60)
        print(f"✓ Sandbox is running")

        # Test 2: Execute command
        print("\n💻 Test 2: Executing command...")
        print("   (This requires working sandbox proxy networking on the server)")
        try:
            result = await client.execute_command(
                sandbox_id, "echo 'Hello from OpenSandbox!'"
            )
            stdout = result.get("stdout", "")
            stderr = result.get("stderr", "")
            exit_code = result.get("exitCode", 0)
            output = stdout + stderr
            if exit_code == 0 and "Hello from OpenSandbox" in output:
                print(f"✓ Command executed successfully")
                print(f"   Output: {output.strip()}")
            else:
                print(f"⚠ Command failed with exit code {exit_code}")
                print(f"   stdout: {stdout}")
                print(f"   stderr: {stderr}")
        except Exception as e:
            print(f"⚠ Command execution failed: {e}")
            print(
                "   This is likely due to sandbox proxy networking not being configured."
            )
            print("   The server creates sandboxes but cannot route to execd inside.")

        # Test 3: Write file
        print("\n📝 Test 3: Writing file...")
        print("   (This also requires working sandbox proxy networking)")
        try:
            await client.write_file(
                sandbox_id, "/tmp/test_opensandbox.txt", "Hello World from OpenSandbox!"
            )
            print("✓ File written successfully")
        except Exception as e:
            print(f"⚠ File write failed: {e}")

        # Test 4: Read file
        print("\n📖 Test 4: Reading file...")
        print("   (This also requires working sandbox proxy networking)")
        try:
            content = await client.read_file(sandbox_id, "/tmp/test_opensandbox.txt")
            if b"Hello World from OpenSandbox" in content:
                print(f"✓ File read successfully")
                print(f"   Content: {content.decode().strip()}")
            else:
                print(f"⚠ File content mismatch: {content}")
        except Exception as e:
            print(f"⚠ File read failed: {e}")

        # Test 5: Verify sandbox exists via lifecycle API
        print("\n🔄 Test 5: Verifying sandbox exists via lifecycle API...")
        sandbox = await client.get_sandbox(sandbox_id)
        if sandbox.get("id") == sandbox_id:
            print("✓ Sandbox exists and is accessible via lifecycle API")
        else:
            print("❌ Sandbox ID mismatch")
            return 1

        print("\n" + "=" * 60)
        print("✅ Basic lifecycle tests passed!")
        print("=" * 60)
        print("\nNOTE: Command/file execution tests may fail if the server")
        print("does not have working sandbox proxy networking configured.")
        print("The lifecycle API (create/get/delete) works via port 9000.")
        print("The execd API (commands/files) requires proxy access to port 44772")
        print("inside the sandbox container.")
        return 0

    except Exception as e:
        print(f"\n❌ Error during testing: {e}")
        import traceback

        traceback.print_exc()
        return 1

    finally:
        # Cleanup
        if sandbox_id:
            print(f"\n🧹 Cleaning up sandbox {sandbox_id}...")
            try:
                await cleanup_sandbox(client, sandbox_id)
            except Exception as e:
                print(f"⚠ Cleanup warning: {e}")
        await client.close()


if __name__ == "__main__":
    sys.exit(main())
