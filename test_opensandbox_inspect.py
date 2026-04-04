#!/usr/bin/env python3
"""Inspect execd status in a running sandbox.

This script creates a sandbox and keeps it alive for inspection.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from typing import Any

import httpx

DEFAULT_OPENSANDBOX_URL = "http://127.0.0.1:9000"


def get_opensandbox_url() -> str:
    return os.environ.get("OPENSANDBOX_URL", DEFAULT_OPENSANDBOX_URL)


class InspectorClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=120.0)

    async def close(self) -> None:
        await self.client.aclose()

    async def create_sandbox(self, image: str, timeout: int = 300) -> dict[str, Any]:
        payload = {
            "image": {"uri": image},
            "timeout": timeout,
            "entrypoint": ["sleep", "infinity"],
            "resourceLimits": {"cpu": "500m", "memory": "512Mi"},
        }
        response = await self.client.post("/sandboxes", json=payload)
        response.raise_for_status()
        return response.json()

    async def get_sandbox(self, sandbox_id: str) -> dict[str, Any]:
        response = await self.client.get(f"/sandboxes/{sandbox_id}")
        response.raise_for_status()
        return response.json()

    async def kill_sandbox(self, sandbox_id: str) -> None:
        response = await self.client.delete(f"/sandboxes/{sandbox_id}")
        response.raise_for_status()


def run_docker_command(cmd: list[str]) -> str:
    """Run a docker command and return output."""
    try:
        result = subprocess.run(
            ["docker"] + cmd,
            capture_output=True,
            text=True,
            timeout=30
        )
        return result.stdout + result.stderr
    except Exception as e:
        return f"Error: {e}"


async def inspect_sandbox(sandbox_id: str) -> None:
    """Inspect the sandbox container."""
    print("\n🔍 Inspecting sandbox container...")

    # Find the container
    find_cmd = [
        "ps", "-f", f"label=opensandbox.io/sandbox-id={sandbox_id}",
        "--format", "{{.ID}}"
    ]
    container_id = run_docker_command(find_cmd).strip()

    if not container_id:
        print("❌ Container not found")
        return

    print(f"   Container ID: {container_id}")

    # Check if execd binary exists
    print("\n📁 Checking /opt/opensandbox/:")
    ls_result = run_docker_command(["exec", container_id, "ls", "-la", "/opt/opensandbox/"])
    print(f"   {ls_result}")

    # Check if execd is running
    print("\n🔎 Checking if execd is running:")
    ps_result = run_docker_command(["exec", container_id, "ps", "aux"])
    if "execd" in ps_result:
        print("   ✓ execd process found")
        for line in ps_result.split("\n"):
            if "execd" in line:
                print(f"     {line.strip()}")
    else:
        print("   ❌ execd process NOT found")
        print(f"   Process list: {ps_result}")

    # Check execd log file
    print("\n📄 Checking /tmp/execd.log:")
    log_result = run_docker_command(["exec", container_id, "cat", "/tmp/execd.log"])
    if log_result.startswith("Error"):
        print(f"   ⚠ Could not read log: {log_result}")
    else:
        if log_result.strip():
            print(f"   {log_result}")
        else:
            print("   (log file is empty)")

    # Check bootstrap script
    print("\n📜 Checking bootstrap script:")
    bootstrap_result = run_docker_command(["exec", container_id, "cat", "/opt/opensandbox/bootstrap.sh"])
    print(f"   {bootstrap_result}")


async def main() -> int:
    print("=" * 60)
    print("OpenSandbox Execd Inspector")
    print("=" * 60)

    opensandbox_url = get_opensandbox_url()
    print(f"\n📍 OpenSandbox URL: {opensandbox_url}")

    client = InspectorClient(opensandbox_url)
    sandbox_id: str | None = None

    try:
        print("\n📦 Creating sandbox...")
        image = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2"
        result = await client.create_sandbox(image=image, timeout=300)
        sandbox_id = result.get("id") or result.get("sandboxId")
        print(f"✓ Sandbox created: {sandbox_id}")

        # Wait for sandbox to be ready
        print("\n⏳ Waiting for sandbox to be ready...")
        while True:
            sandbox = await client.get_sandbox(sandbox_id)
            status = sandbox.get("status", {})
            if isinstance(status, dict):
                state = status.get("state", "").lower()
            else:
                state = str(status).lower()
            if state == "running":
                print(f"   Status: {state}")
                break
            await asyncio.sleep(1)

        # Inspect the sandbox
        await inspect_sandbox(sandbox_id)

        print("\n" + "=" * 60)
        print("Sandbox is still running for manual inspection.")
        print(f"Container: docker ps -f label=opensandbox.io/sandbox-id={sandbox_id}")
        print(f"Logs: docker exec <container> cat /tmp/execd.log")
        print("=" * 60)
        print("\nPress Enter to cleanup and exit...")
        input()

        return 0

    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        return 0
    except Exception as e:
        print(f"\n❌ Error: {e}")
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


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
