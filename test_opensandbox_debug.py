#!/usr/bin/env python3
"""Diagnostic script for OpenSandbox execd proxy issues.

This script helps diagnose why the execd proxy returns 502 Bad Gateway.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any

import httpx

# Default OpenSandbox URL
DEFAULT_OPENSANDBOX_URL = "http://127.0.0.1:9000"


def get_opensandbox_url() -> str:
    """Get OpenSandbox URL from environment or use default."""
    return os.environ.get("OPENSANDBOX_URL", DEFAULT_OPENSANDBOX_URL)


class OpenSandboxDiagnosticClient:
    """Diagnostic client for OpenSandbox."""

    EXECD_PORT = 44772

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=120.0)

    async def close(self) -> None:
        await self.client.aclose()

    async def create_sandbox(
        self,
        image: str,
        timeout: int = 300,
        entrypoint: list[str] | None = None,
    ) -> dict[str, Any]:
        """Create a new sandbox."""
        if entrypoint is None:
            entrypoint = ["sleep", "infinity"]

        payload = {
            "image": {"uri": image},
            "timeout": timeout,
            "entrypoint": entrypoint,
            "resourceLimits": {"cpu": "500m", "memory": "512Mi"},
        }

        response = await self.client.post("/sandboxes", json=payload)
        if response.status_code >= 400:
            print(f"   Error response: {response.text}")
        response.raise_for_status()
        return response.json()

    async def get_sandbox(self, sandbox_id: str) -> dict[str, Any]:
        """Get sandbox status."""
        response = await self.client.get(f"/sandboxes/{sandbox_id}")
        response.raise_for_status()
        return response.json()

    async def wait_for_sandbox(self, sandbox_id: str, timeout: int = 60) -> dict[str, Any]:
        """Wait for sandbox to be ready."""
        start = time.time()
        while time.time() - start < timeout:
            sandbox = await self.get_sandbox(sandbox_id)
            status = sandbox.get("status")
            if isinstance(status, dict):
                state = (
                    status.get("state", "").lower() if "state" in status else str(status).lower()
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

    async def check_execd_health(self, sandbox_id: str) -> dict[str, Any]:
        """Check execd health via proxy."""
        execd_path = self._get_execd_proxy_path(sandbox_id)
        response = await self.client.get(f"{execd_path}/health")
        response.raise_for_status()
        return response.json()

    async def execute_command(
        self, sandbox_id: str, command: str, timeout_ms: int = 30000
    ) -> dict[str, Any]:
        """Execute a command in the sandbox via execd proxy API."""
        execd_path = self._get_execd_proxy_path(sandbox_id)
        payload = {"command": command, "timeout": timeout_ms}

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
        """Parse Server-Sent Events response from command execution."""
        stdout_parts = []
        stderr_parts = []
        exit_code = 0
        error = None

        for line in content.split("\n"):
            line = line.strip()
            if line.startswith("data:"):
                data = line[5:].strip()
                try:
                    event = json.loads(data)
                    event_type = event.get("type")

                    if event_type == "stdout":
                        stdout_parts.append(event.get("data", ""))
                    elif event_type == "stderr":
                        stderr_parts.append(event.get("data", ""))
                    elif event_type == "error":
                        error = event.get("data", "")
                    elif event_type == "exit":
                        exit_code_str = event.get("data", "0")
                        try:
                            exit_code = int(exit_code_str)
                        except ValueError:
                            exit_code = 0
                except json.JSONDecodeError:
                    continue

        return {
            "stdout": "".join(stdout_parts),
            "stderr": "".join(stderr_parts),
            "exitCode": exit_code,
            "error": error,
        }

    async def kill_sandbox(self, sandbox_id: str) -> None:
        """Kill/delete a sandbox."""
        response = await self.client.delete(f"/sandboxes/{sandbox_id}")
        response.raise_for_status()


async def run_diagnostics(opensandbox_url: str) -> int:
    """Run diagnostic tests."""
    client = OpenSandboxDiagnosticClient(opensandbox_url)
    sandbox_id: str | None = None

    try:
        # Create sandbox
        print("\n📦 Creating sandbox...")
        image = (
            "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2"
        )
        result = await client.create_sandbox(
            image=image,
            timeout=300,
            entrypoint=["sleep", "infinity"],
        )
        sandbox_id = result.get("id") or result.get("sandboxId")
        print(f"✓ Sandbox created: {sandbox_id}")

        # Wait for sandbox
        print("\n⏳ Waiting for sandbox to be ready...")
        sandbox = await client.wait_for_sandbox(sandbox_id, timeout=60)
        print("✓ Sandbox is running")

        # Get full sandbox info
        print("\n📋 Sandbox details:")
        print(f"   ID: {sandbox_id}")
        print(f"   Status: {sandbox.get('status')}")
        print(f"   Image: {sandbox.get('image', {}).get('uri', 'N/A')}")
        print(f"   Entrypoint: {sandbox.get('entrypoint', 'N/A')}")

        # Try health check
        print("\n🔍 Testing execd health check...")
        try:
            health = await client.check_execd_health(sandbox_id)
            print(f"✓ Health check passed: {health}")
        except Exception as e:
            print(f"❌ Health check failed: {e}")
            print("   This suggests execd is not running or not accessible")

        # Try command execution
        print("\n💻 Testing command execution...")
        try:
            result = await client.execute_command(sandbox_id, "echo 'Hello from OpenSandbox!'")
            stdout = result.get("stdout", "")
            stderr = result.get("stderr", "")
            exit_code = result.get("exitCode", 0)
            error = result.get("error")

            if exit_code == 0 and "Hello from OpenSandbox" in stdout:
                print("✓ Command executed successfully")
                print(f"   Output: {stdout.strip()}")
            else:
                print(f"❌ Command failed with exit code {exit_code}")
                print(f"   stdout: {stdout}")
                print(f"   stderr: {stderr}")
                if error:
                    print(f"   error: {error}")
        except httpx.HTTPStatusError as e:
            print(f"❌ Command execution failed with HTTP {e.response.status_code}")
            print(f"   Response: {e.response.text}")
        except Exception as e:
            print(f"❌ Command execution failed: {e}")

        print("\n" + "=" * 60)
        print("Diagnostic complete!")
        print("=" * 60)
        return 0

    except Exception as e:
        print(f"\n❌ Error during diagnostics: {e}")
        import traceback

        traceback.print_exc()
        return 1

    finally:
        if sandbox_id:
            print(f"\n🧹 Cleaning up sandbox {sandbox_id}...")
            try:
                await client.kill_sandbox(sandbox_id)
                print("✓ Cleanup complete")
            except Exception as e:
                print(f"⚠ Cleanup warning: {e}")
        await client.close()


def main() -> int:
    """Run diagnostics."""
    print("=" * 60)
    print("OpenSandbox Diagnostic Tool")
    print("=" * 60)

    opensandbox_url = get_opensandbox_url()
    print(f"\n📍 OpenSandbox URL: {opensandbox_url}")

    return asyncio.run(run_diagnostics(opensandbox_url))


if __name__ == "__main__":
    sys.exit(main())
