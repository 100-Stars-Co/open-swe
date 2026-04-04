---
description: "Use when writing tests for Open SWE. Covers pytest conventions, asyncio_mode auto, mocking sandbox backends with fake classes, and file naming rules. No live sandbox calls in unit tests."
applyTo: "tests/**/*.py"
---

# Writing Tests for Open SWE

## File Naming and Location

- All test files live in `tests/`
- Name: `test_<module_name>.py` (mirrors the module under test)
- Run all tests: `make test`
- Run one file: `make test TEST_FILE=tests/test_my_module.py`

## Pytest Async — No Decorator Needed

`asyncio_mode = "auto"` is configured in `pyproject.toml`. Do **not** add `@pytest.mark.asyncio`:

```python
# Good — async test, no decorator
async def test_my_feature() -> None:
    result = await my_async_function()
    assert result == expected

# Bad — unnecessary decorator
@pytest.mark.asyncio
async def test_my_feature() -> None:
    ...
```

## Mocking the Sandbox — Never Call a Live Sandbox

Unit tests must not connect to any real sandbox. Use fake/stub classes:

```python
from deepagents.backends.protocol import ExecuteResponse


class _FakeSandboxBackend:
    def __init__(
        self,
        *,
        shell_paths: dict[str, str] | None = None,
    ) -> None:
        self.shell_paths = shell_paths or {}
        self.commands: list[str] = []

    @property
    def id(self) -> str:
        return "fake-sandbox"

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        del timeout
        self.commands.append(command)
        if command in self.shell_paths:
            return ExecuteResponse(output=self.shell_paths[command], exit_code=0, truncated=False)
        return ExecuteResponse(output="", exit_code=0, truncated=False)
```

Use `unittest.mock.patch` to inject the fake where needed:

```python
from unittest.mock import patch


def test_my_utility() -> None:
    fake = _FakeSandboxBackend(shell_paths={"echo hi": "hi"})
    with patch("agent.utils.sandbox_state.get_sandbox_backend_sync", return_value=fake):
        result = my_utility_function()
    assert result == "hi"
```

## Type Hints

Add return type annotations to all test functions (even `-> None`):

```python
def test_extract_urls_empty() -> None:
    assert extract_image_urls("") == []
```

## Import Style

```python
from __future__ import annotations  # only if needed for forward refs

import pytest  # only if using fixtures or marks
from agent.utils.my_module import function_under_test
```

## What to Test

- **Happy path** — expected inputs produce expected outputs
- **Edge cases** — empty strings, `None`, missing keys
- **Error paths** — invalid env vars, malformed input

Keep tests short and focused. Prefer many small tests over one large test.
