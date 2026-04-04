#!/usr/bin/env python3
"""Test OpenSandbox integration using the SDK (like the real integration)."""

from __future__ import annotations

import asyncio
import os
import sys
import warnings
from datetime import timedelta
from typing import Any

# Suppress langsmith alpha warning
warnings.filterwarnings("ignore", message="langsmith.sandbox is in alpha", category=FutureWarning)

# Default OpenSandbox settings
DEFAULT_OPENSANDBOX_URL = "http://127.0.0.1:9000"
DEFAULT_OPENSANDBOX_TEMPLATE = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2"


def get_opensandbox_url() -> str:
    """Get OpenSandbox URL from environment or use default."""
    return os.environ.get("OPENSANDBOX_URL", DEFAULT_OPENSANDBOX_URL)


def get_opensandbox_template() -> str:
    """Get OpenSandbox template from environment or use default."""
    return os.environ.get("OPENSANDBOX_TEMPLATE", DEFAULT_OPENSANDBOX_TEMPLATE)


async def run_tests() -> int:
    """Run all tests using the OpenSandbox SDK."""
    print("=" * 60)
    print("OpenSandbox SDK Test")
    print("=" * 60)

    # Import OpenSandbox SDK
    try:
        from opensandbox import Sandbox
        from opensandbox.config import ConnectionConfig
        print("✓ OpenSandbox SDK imported successfully")
    except ImportError as exc:
        print(f"❌ Failed to import OpenSandbox SDK: {exc}")
        print("   Install with: uv pip install 'opensandbox'")
        return 1

    server_url = get_opensandbox_url()
    template = get_opensandbox_template()

    print(f"\n📍 OpenSandbox URL: {server_url}")
    print(f"📦 Template: {template}")

    # SDK uses OPEN_SANDBOX_DOMAIN env var, not server_url parameter
    # Extract domain from URL (e.g., "http://127.0.0.1:9000" -> "127.0.0.1:9000")
    from urllib.parse import urlparse
    parsed = urlparse(server_url)
    domain = parsed.netloc or server_url.replace("http://", "").replace("https://", "")
    os.environ["OPEN_SANDBOX_DOMAIN"] = domain
    print(f"✓ Set OPEN_SANDBOX_DOMAIN={domain}")

    # Build connection config (reads from env var)
    connection_config = ConnectionConfig()
    print(f"✓ SDK will connect to: {connection_config.get_base_url()}")

    sandbox: Any = None
    sandbox_id: str | None = None

    try:
        # Test 1: Create sandbox
        print("\n📦 Test 1: Creating sandbox...")
        sandbox = await Sandbox.create(
            image=template,
            timeout=timedelta(seconds=300),
            connection_config=connection_config,
        )
        sandbox_id = sandbox.id  # Note: uses 'id', not 'sandbox_id'
        print(f"✓ Sandbox created: {sandbox_id}")

        # Helper to extract output from Execution result
        def get_output(result):
            """Extract stdout text from Execution result."""
            if hasattr(result, 'logs') and result.logs:
                stdout_msgs = result.logs.stdout if hasattr(result.logs, 'stdout') else []
                return "".join(m.text for m in stdout_msgs if hasattr(m, 'text'))
            return ""

        def get_stderr(result):
            """Extract stderr text from Execution result."""
            if hasattr(result, 'logs') and result.logs:
                stderr_msgs = result.logs.stderr if hasattr(result.logs, 'stderr') else []
                return "".join(m.text for m in stderr_msgs if hasattr(m, 'text'))
            return ""

        # Test 2: Execute command
        print("\n💻 Test 2: Executing command...")
        result = await sandbox.commands.run("echo 'Hello from OpenSandbox!'")
        output = get_output(result)
        if "Hello from OpenSandbox" in output:
            print(f"✓ Command executed successfully")
            print(f"   Output: {output.strip()}")
        else:
            print(f"❌ Command failed or unexpected output: {output!r}")
            return 1

        # Test 3: Execute command with stderr
        print("\n💻 Test 3: Testing stderr capture...")
        result = await sandbox.commands.run("echo 'error message' >&2")
        stderr = get_stderr(result)
        stdout = get_output(result)
        if "error message" in stderr or "error message" in stdout:
            print(f"✓ Stderr captured successfully")
            print(f"   stderr: {stderr.strip()!r}")
            print(f"   stdout: {stdout.strip()!r}")
        else:
            print(f"⚠ Stderr capture might not work")
            print(f"   stderr: {stderr!r}")
            print(f"   stdout: {stdout!r}")

        # Test 4: Write file
        print("\n📝 Test 4: Writing file...")
        from opensandbox.models import WriteEntry
        entry = WriteEntry(
            path="/tmp/test_opensandbox.txt",
            data=b"Hello World from OpenSandbox!",
            mode=644
        )
        await sandbox.files.write_files([entry])
        print("✓ File written successfully")

        # Test 5: Read file
        print("\n📖 Test 5: Reading file...")
        content = await sandbox.files.read_file("/tmp/test_opensandbox.txt")
        # Content may be bytes or string depending on SDK version
        if isinstance(content, bytes):
            content_str = content.decode('utf-8')
        else:
            content_str = content
        if "Hello World from OpenSandbox" in content_str:
            print(f"✓ File read successfully")
            print(f"   Content: {content_str.strip()}")
        else:
            print(f"❌ File content mismatch: {content!r}")
            return 1

        # Test 6: Reconnect to existing sandbox
        print("\n🔄 Test 6: Reconnecting to existing sandbox...")
        await sandbox.close()  # Close current connection
        sandbox = await Sandbox.connect(sandbox_id, connection_config=connection_config)
        result = await sandbox.commands.run("echo 'Reconnected!'")
        output = get_output(result)
        if "Reconnected" in output:
            print("✓ Sandbox reconnected successfully")
        else:
            print("❌ Sandbox reconnection failed")
            return 1

        print("\n" + "=" * 60)
        print("✅ All tests passed!")
        print("=" * 60)
        return 0

    except Exception as e:
        print(f"\n❌ Error during testing: {e}")
        import traceback
        traceback.print_exc()
        return 1

    finally:
        # Cleanup
        if sandbox:
            print(f"\n🧹 Cleaning up sandbox {sandbox_id}...")
            try:
                await sandbox.close()
                print("✓ Sandbox connection closed")
            except Exception as e:
                print(f"⚠ Cleanup warning: {e}")


def main() -> int:
    """Run the test."""
    return asyncio.run(run_tests())


if __name__ == "__main__":
    sys.exit(main())
