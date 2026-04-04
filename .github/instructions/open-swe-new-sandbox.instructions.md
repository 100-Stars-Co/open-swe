---
description: "Use when adding a new sandbox provider or backend integration to Open SWE. Covers SandboxBackendProtocol, BaseSandbox, factory function pattern, and registration in SANDBOX_FACTORIES."
---

# Adding a New Sandbox Integration

## 1. Create the Provider File

Create `agent/integrations/<provider>.py`. Implement `BaseSandbox` (which satisfies `SandboxBackendProtocol`):

```python
# agent/integrations/myprovider.py
"""MyProvider sandbox backend implementation."""

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

DEFAULT_MYPROVIDER_TIMEOUT = 300


class MyProviderBackend(BaseSandbox):
    """MyProvider backend conforming to SandboxBackendProtocol."""

    def __init__(self, sandbox: Any) -> None:
        self._sandbox = sandbox
        self._default_timeout = DEFAULT_MYPROVIDER_TIMEOUT

    @property
    def id(self) -> str:
        return self._sandbox.id

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        ...

    def write_file(self, path: str, content: bytes) -> WriteResult:
        ...

    def read_file(self, path: str) -> bytes:
        ...

    def upload_file(self, local_path: str, remote_path: str) -> FileUploadResponse:
        ...

    def download_file(self, remote_path: str, local_path: str) -> FileDownloadResponse:
        ...

    def get_work_dir(self) -> str:
        ...

    def get_user_home_dir(self) -> str:
        ...

    def close(self) -> None:
        ...


def create_myprovider_sandbox(
    sandbox_id: str | None = None,
    timeout: int | None = None,
) -> MyProviderBackend:
    """Create or reconnect to a MyProvider sandbox.

    Args:
        sandbox_id: Existing sandbox ID to reconnect to, or None to create new.
        timeout: Sandbox lease timeout in seconds.

    Returns:
        MyProviderBackend instance.
    """
    # SDK call to create/reconnect sandbox
    ...
    return MyProviderBackend(sdk_sandbox)
```

**Rules:**

- Use `from __future__ import annotations` at the top.
- Module-level logger: `logger = logging.getLogger(__name__)`
- Define `DEFAULT_<PROVIDER>_TIMEOUT` as a module constant, not hardcoded.
- Expose a top-level `create_<provider>_sandbox(sandbox_id, timeout)` factory function.

## 2. Register in `agent/utils/sandbox.py`

Import the factory and add it to `SANDBOX_FACTORIES`:

```python
from agent.integrations.myprovider import create_myprovider_sandbox

SANDBOX_FACTORIES = {
    ...,
    "myprovider": create_myprovider_sandbox,
}
```

If the provider has optional dependencies (heavy SDK), use a lazy import wrapper:

```python
def _create_myprovider_sandbox_lazy(sandbox_id: str | None = None, timeout: int | None = None):
    """Lazy import to avoid ImportError when provider SDK not installed."""
    from agent.integrations.myprovider import create_myprovider_sandbox
    return create_myprovider_sandbox(sandbox_id, timeout=timeout)

SANDBOX_FACTORIES = {
    ...,
    "myprovider": _create_myprovider_sandbox_lazy,
}
```

## 3. Add timeout support in `create_sandbox()`

If the new provider accepts `timeout`, add its key to the conditional in `create_sandbox()`:

```python
if sandbox_type in ("e2b", "opensandbox", "myprovider"):
    return factory(sandbox_id, timeout=timeout)
return factory(sandbox_id)
```

## 4. Document the Env Variable

Add the new `SANDBOX_TYPE` value and required env vars to `INSTALLATION.md` and `CLAUDE.md`.

## Checklist

- [ ] `agent/integrations/<provider>.py` with `BaseSandbox` subclass
- [ ] `create_<provider>_sandbox(sandbox_id, timeout)` factory function
- [ ] Registered in `SANDBOX_FACTORIES` in `agent/utils/sandbox.py`
- [ ] Timeout handling updated in `create_sandbox()` if needed
- [ ] `INSTALLATION.md` / `CLAUDE.md` updated with env var docs
