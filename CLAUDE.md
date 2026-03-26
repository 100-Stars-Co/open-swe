# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Open SWE is an open-source LangGraph-based AI coding agent that automates software engineering tasks. It clones GitHub repos into isolated cloud sandboxes, executes commands, modifies files, runs tests, and opens GitHub draft PRs. It's triggered via Slack, Linear, or GitHub webhooks.

## Common Commands

```bash
# Install dependencies (uses uv - never pip install directly)
make install

# Development servers
make dev              # LangGraph dev server with live reload (http://localhost:3000)
make run              # FastAPI webhook server (http://localhost:8000)

# Testing
make test             # Run all tests with pytest
make test TEST_FILE=tests/test_multimodal.py   # Single test file
make integration_tests  # Run integration tests

# Code quality
make lint             # ruff check + format --diff
make format           # ruff format + check --fix
```

**Python:** >= 3.11 (3.12 recommended). Use `uv` for package management.

## Architecture

### Entry Points

| File              | Role                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| `agent/server.py` | `get_agent()` — builds the LangGraph agent; called by LangGraph runtime            |
| `agent/webapp.py` | FastAPI app with webhook handlers: `POST /slack`, `POST /linear`, `POST /github`   |
| `agent/prompt.py` | `construct_system_prompt()` — assembles system prompt from structured sections      |

### Directory Structure

```
agent/
  server.py          # Main agent factory (get_agent, sandbox lifecycle, repo clone/pull)
  webapp.py          # FastAPI webhook handlers + auth verification
  prompt.py          # System prompt construction with section templates
  encryption.py      # Fernet-based token encryption/decryption
  tools/             # Custom tools: commit_and_open_pr, fetch_url, http_request,
                     #   github_comment/review, linear_*, slack_thread_reply
  middleware/          # Hooks: ToolErrorMiddleware, check_message_queue,
                     #   ensure_no_empty_msg, open_pr_if_needed
  integrations/      # Sandbox provider factories: langsmith, daytona, runloop, modal, local, e2b
  utils/             # Shared helpers: auth, github, slack, linear, sandbox, model, multimodal
```

### Agent Execution Flow

```
Webhook (Slack/Linear/GitHub)
  → webapp.py verifies signature, extracts context
  → create/reconnect sandbox (thread-persistent)
  → clone/pull repo, read CLAUDE.md (or AGENTS.md) from repo root
  → get_agent() → DeepAgent loop (tools + middleware)
  → commit_and_open_pr tool
  → post result back to trigger channel
```

### Key Design Patterns

1. **Isolation First** — each task runs in its own cloud sandbox (`SANDBOX_TYPE` env var)
   - Supported: `langsmith` (default), `daytona`, `modal`, `runloop`, `local`, `e2b`
   - Sandboxes are thread-persistent and auto-recreate on connection failure

2. **Deep Agents Framework** — agent is composed via `create_deep_agent()` from the `deepagents` package
   - Model: configurable via `DEEPAGENTS_MODEL` (default: `anthropic:claude-opus-4-6`)
   - Built-in tools: `read_file`, `write_file`, `edit_file`, `ls`, `glob`, `grep`, `task` (subagent spawning)

3. **Middleware Hooks** — deterministic code that runs around the agent loop:
   - `check_message_queue_before_model` — injects follow-up messages mid-run
   - `open_pr_if_needed` — safety net that auto-commits/opens PR if agent didn't
   - `ToolErrorMiddleware` — catches and handles tool errors gracefully

4. **Context Engineering** — system prompt assembled from:
   - Structured sections in `prompt.py` (working env, task execution, coding standards, etc.)
   - Optional `CLAUDE.md` or `AGENTS.md` file from target repo (injected automatically, CLAUDE.md takes precedence)

### Adding Components

**New Tool:**
1. Create `agent/tools/<tool_name>.py` exporting an `@tool`-decorated function
2. Register in `agent/tools/__init__.py`
3. Add to the tool list in `agent/server.py:get_agent()`

**New Sandbox Provider:**
1. Create `agent/integrations/<provider>.py` implementing `SandboxBackendProtocol`
2. Register factory in `agent/integrations/__init__.py` and `agent/utils/sandbox.py:SANDBOX_FACTORIES`

**New Middleware:**
1. Create `agent/middleware/<middleware>.py` with hook function/class
2. Register in `agent/middleware/__init__.py`
3. Add to middleware list in `agent/server.py:get_agent()`

## Tech Stack

| Layer                | Technology                                                                            |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Agent framework**  | LangGraph >= 1.0.8, DeepAgents >= 0.4.3                                                 |
| **HTTP server**      | FastAPI + Uvicorn                                                                     |
| **LLM**              | Anthropic Claude (primary), OpenAI/OpenRouter/Ollama (configurable via `DEEPAGENTS_MODEL`)  |
| **HTTP client**      | `httpx`                                                                               |
| **Linter/formatter** | Ruff (100-char lines, isort, Black-like)                                              |
| **Test runner**      | Pytest with `asyncio_mode = "auto"`                                                   |
| **Packaging**        | `uv`, `pyproject.toml`                                                                |

## Conventions

- **Style:** Ruff-enforced. Run `make format` before committing.
- **Imports:** isort-sorted. Ruff handles automatically.
- **Type hints:** Required on all new public functions and methods.
- **Async:** All webhook handlers and agent-facing functions are `async`.
- **Tools:** Each tool is a single file in `agent/tools/`. Use the `@tool` decorator from LangChain.
- **Tests:** Place in `tests/test_<module>.py`. `pytest.mark.asyncio` unnecessary — `asyncio_mode = "auto"` handles it.
- **No sandbox calls in unit tests** — mock the sandbox client; tests run without a live sandbox.
- **Target repo conventions** — if the target repo has a `CLAUDE.md` or `AGENTS.md`, that file is automatically injected into the system prompt. Org-specific rules go there. `CLAUDE.md` takes precedence if both exist.

## Environment Variables

Configuration is loaded from `.env`. Key variables:

```
# LLM
ANTHROPIC_API_KEY
DEEPAGENTS_MODEL              # e.g. "anthropic:claude-opus-4-6", "ollama:llama3.3"
OLLAMA_BASE_URL               # Optional: custom Ollama server URL (default: http://localhost:11434)

# GitHub App (required)
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_INSTALLATION_ID
GITHUB_WEBHOOK_SECRET

# LangSmith (default sandbox + tracing)
LANGSMITH_API_KEY_PROD
LANGSMITH_TENANT_ID_PROD

# Optional integrations
LINEAR_API_KEY / LINEAR_WEBHOOK_SECRET
SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET

# Sandbox
SANDBOX_TYPE                # "langsmith" | "daytona" | "runloop" | "modal" | "local" | "e2b"
TOKEN_ENCRYPTION_KEY        # Base64 32-byte Fernet key
```

## Critical Pitfalls

- **Never run agent tools locally against your filesystem** — tools execute inside a sandbox; local paths will differ.
- **Don't modify `agent/prompt.py` sections lightly** — the prompt is structured into named sections consumed by `construct_system_prompt()`; changing section keys breaks injection.
- **`SANDBOX_TYPE=local` is dev-only** — it runs commands directly on the host; never use in production.
- **`TOKEN_ENCRYPTION_KEY` must be a valid Fernet key** — generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
