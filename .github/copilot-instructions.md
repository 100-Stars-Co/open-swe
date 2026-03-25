# Open SWE — Copilot Instructions

## Project Overview

Open SWE is an open-source LangGraph-based AI coding agent that automates software engineering tasks. It clones GitHub repos into isolated cloud sandboxes, executes commands, modifies files, runs tests, and opens GitHub draft PRs. It's triggered via Slack, Linear, or GitHub webhooks.

Reference docs: [README.md](../README.md) · [INSTALLATION.md](../INSTALLATION.md) · [CUSTOMIZATION.md](../CUSTOMIZATION.md)

---

## Quick Start

```bash
# Install dependencies
make install        # uses uv

# Development
make dev            # langgraph dev with live reload (http://localhost:3000)
make run            # FastAPI app at http://localhost:8000

# Tests
make test           # run all tests (uses pytest)
make test TEST_FILE=tests/test_multimodal.py  # single test file

# Code quality
make lint           # ruff check
make format         # ruff format (applies fixes)
```

**Python:** ≥ 3.11 (3.12 recommended). Use `uv` for package management — never `pip install` directly.

---

## Architecture

### Entry Points

| File              | Role                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| `agent/server.py` | `get_agent()` — builds the LangGraph agent; called by LangGraph runtime            |
| `agent/webapp.py` | FastAPI app with webhook handlers: `POST /slack`, `POST /linear`, `POST /github`   |
| `agent/prompt.py` | `construct_system_prompt()` — assembles the system prompt from structured sections |

### Directory Map

```
agent/
  server.py        # Main agent factory (get_agent, sandbox lifecycle, repo clone/pull)
  webapp.py        # FastAPI webhook handlers + auth verification
  prompt.py        # System prompt construction
  encryption.py    # Fernet-based token encryption/decryption
  tools/           # Custom tools: commit_and_open_pr, fetch_url, http_request,
                   #   github_comment/review, linear_*, slack_thread_reply
  middleware/      # Hooks: ToolErrorMiddleware, check_message_queue, ensure_no_empty_msg, open_pr_if_needed
  integrations/    # Sandbox provider factories: langsmith, daytona, runloop, modal, local
  utils/           # Shared helpers: auth, github, slack, linear, sandbox, model, multimodal, etc.
tests/             # Pytest unit tests for utilities, webhooks, prompt formatting
```

### Key Design Principles

1. **Isolation First** — each task runs in its own cloud sandbox (`SANDBOX_TYPE`, default: `langsmith`)
2. **Curated Tools** — small focused toolset; avoid tool accumulation
3. **Context Engineering** — rich context injected from platform events and `AGENTS.md` in target repos
4. **Safety Net** — `open_pr_if_needed` middleware auto-commits/opens PR if agent didn't

### Agent Execution Flow

```
Webhook (Slack/Linear/GitHub)
  → webapp.py verifies signature, extracts context
  → create/reconnect sandbox
  → clone/pull repo, read AGENTS.md
  → get_agent() → DeepAgent loop (tools + middleware)
  → commit_and_open_pr tool
  → post result back to trigger channel
```

### Adding a New Tool

1. Create `agent/tools/<tool_name>.py` exporting an `@tool`-decorated function
2. Register it in `agent/tools/__init__.py`
3. Add it to the tool list in `agent/server.py`

### Adding a New Integration (Sandbox Provider)

Create `agent/integrations/<provider>.py` implementing the sandbox factory interface. Register in `agent/integrations/__init__.py`.

---

## Tech Stack

| Layer                | Technology                                                                            |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Agent framework**  | LangGraph ≥ 1.0.8, DeepAgents ≥ 0.4.3                                                 |
| **HTTP server**      | FastAPI + Uvicorn                                                                     |
| **LLM**              | Anthropic Claude (primary), OpenAI / OpenRouter (configurable via `DEEPAGENTS_MODEL`) |
| **HTTP client**      | `httpx`                                                                               |
| **Linter/formatter** | Ruff (100-char lines, isort, Black-like)                                              |
| **Test runner**      | Pytest with `asyncio_mode = "auto"`                                                   |
| **Packaging**        | `uv`, `pyproject.toml`                                                                |

---

## Environment Variables

Configuration is loaded from `.env`. The most critical vars:

```
# LLM
ANTHROPIC_API_KEY
DEEPAGENTS_MODEL           # e.g. "anthropic:claude-opus-4-6"

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
SANDBOX_TYPE               # "langsmith" | "daytona" | "runloop" | "modal" | "local"
TOKEN_ENCRYPTION_KEY       # Base64 32-byte Fernet key
```

For the full list see [INSTALLATION.md](../INSTALLATION.md).

---

## Conventions

- **Style:** Ruff-enforced. Run `make format` before committing.
- **Imports:** isort-sorted. Ruff handles this automatically.
- **Type hints:** Required on all new public functions and methods.
- **Async:** All webhook handlers and agent-facing functions are `async`.
- **Tools:** Each tool is a single file in `agent/tools/`. The `@tool` decorator from LangChain is used.
- **Tests:** Place in `tests/test_<module>.py`. Use `pytest.mark.asyncio` is unnecessary — `asyncio_mode = "auto"` handles it.
- **No sandbox calls in unit tests** — mock the sandbox client; tests run without a live sandbox.
- **Target repo conventions** — if the target repo has an `AGENTS.md`, that file is automatically injected into the system prompt. Org-specific rules go there, not here.

---

## Common Pitfalls

- **Never run agent tools locally against your filesystem** — tools execute inside a sandbox; local paths will differ.
- **Don't modify `agent/prompt.py` sections lightly** — the prompt is structured into named sections consumed by `construct_system_prompt()`; changing section keys breaks injection.
- **`SANDBOX_TYPE=local` is dev-only** — it runs commands directly on the host; never use in production.
- **`TOKEN_ENCRYPTION_KEY` must be a valid Fernet key** — generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
