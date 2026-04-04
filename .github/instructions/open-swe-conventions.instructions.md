---
description: "Use when writing any Python code in this repo. Covers Open SWE project conventions: package management with uv, ruff linting and formatting, type hints, async patterns, and file structure rules."
applyTo: "agent/**/*.py"
---

# Open SWE Project Conventions

## Package Management

- **Always use `uv`** — never `pip install` directly.
- Add dependencies: `uv add <package>`
- All runtime deps go in `pyproject.toml`.

## Code Style (Ruff-enforced)

- Line length: **100 characters**
- Formatter: ruff (Black-compatible)
- Imports: isort-sorted; run `make format` to fix automatically

Run before committing:

```bash
make format   # applies ruff format + ruff check --fix
make lint     # reports remaining issues
```

## Type Hints

Required on **all new public functions and methods**:

```python
# Good
def create_sandbox(sandbox_id: str | None = None, timeout: int | None = None) -> SandboxBackend:

# Bad — missing return type and parameter types
def create_sandbox(sandbox_id=None, timeout=None):
```

Use `from __future__ import annotations` at the top of files that contain forward references.

## Async

- All webhook handlers and agent-facing functions must be `async`.
- Agent tools that shell out to a sandbox are **synchronous** (the sandbox client handles async internally).

## Logging

Use the module-level logger pattern — not `print`:

```python
import logging
logger = logging.getLogger(__name__)

# Usage
logger.warning("Invalid value %r, falling back to %s", value, default)
```

## Module Layout

```
agent/
  tools/          # One file per tool
  middleware/     # One file per middleware hook
  integrations/   # One file per sandbox provider
  utils/          # Shared helpers — keep focused
```

Never add logic to `__init__.py` beyond imports and `__all__`.

## Environment Variables

- Read via `os.getenv("VAR")` or `os.environ.get("VAR")`.
- Provide sensible defaults via module-level constants:

```python
DEFAULT_TIMEOUT = 300

def _resolve_timeout(timeout: int | None) -> int:
    env_val = os.environ.get("MY_TIMEOUT")
    if env_val:
        try:
            return int(env_val)
        except ValueError:
            logger.warning("Invalid MY_TIMEOUT=%r, falling back to %s", env_val, DEFAULT_TIMEOUT)
    return DEFAULT_TIMEOUT
```
