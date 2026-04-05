"""Integration test: create a Daytona sandbox, run a command, then delete it.

Run manually:
    uv run python tests/test_daytona_cleanup.py
"""

from __future__ import annotations

import os
import ssl
import sys

import certifi
from dotenv import load_dotenv

load_dotenv()

# Fix macOS SSL certificate verification issue with Python Framework installations
os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

_orig_create_default_context = ssl.create_default_context


def _patched_create_default_context(*args, **kwargs):  # type: ignore[misc]
    kwargs.setdefault("cafile", certifi.where())
    return _orig_create_default_context(*args, **kwargs)


ssl.create_default_context = _patched_create_default_context  # type: ignore[assignment]


def main() -> None:
    from agent.integrations.daytona import (
        create_daytona_sandbox,
        delete_daytona_sandbox,
    )

    api_key = os.getenv("DAYTONA_API_KEY")
    if not api_key:
        print("ERROR: DAYTONA_API_KEY is not set in environment")
        sys.exit(1)

    # Step 1: Create sandbox
    print("Creating Daytona sandbox...")
    backend = create_daytona_sandbox()
    print(f"Sandbox created: id={backend.id}")

    # Step 2: Run a command inside the sandbox
    print("\nRunning command in sandbox...")
    result = backend.execute("echo 'Hello from Daytona sandbox' && uname -a")
    print(f"Exit code : {result.exit_code}")
    print(f"Output    : {result.output}")

    # Step 3: Delete the sandbox
    print("\nDeleting sandbox...")
    deleted = delete_daytona_sandbox(backend.id)
    if deleted:
        print(f"Sandbox {backend.id} deleted successfully.")
    else:
        print(f"ERROR: Failed to delete sandbox {backend.id}")
        sys.exit(1)


if __name__ == "__main__":
    main()
