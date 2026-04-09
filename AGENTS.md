# Repository Guidelines

## Project Structure & Module Organization
Core application code lives in `agent/`. Use `agent/integrations/` for sandbox providers, `agent/tools/` for tool implementations, `agent/middleware/` for agent loop hooks, and `agent/utils/` for shared helpers. The FastAPI entrypoint is `agent/webapp.py`; LangGraph wiring also appears in `agent/server.py` and `agent/prompt.py`.

Primary tests live in `tests/` and follow `test_*.py` naming. A few sandbox and debug-oriented tests also live at the repository root, such as `test_opensandbox_sdk.py`. Utility scripts belong in `scripts/`. Static assets for the README live in `static/`.

## Build, Test, and Development Commands
Install dependencies with `make install` or `uv pip install -e .`.

- `make dev`: start the LangGraph dev server.
- `make run`: run the FastAPI webhook app on port `8000`.
- `make test`: run pytest against `tests/` or a custom path, for example `make test TEST_FILE=tests/test_verify_pr.py`.
- `make integration_tests`: run integration tests if `tests/integration_tests/` exists.
- `make lint`: run `ruff check` and a formatting diff.
- `make format`: apply `ruff format` and auto-fix lint issues.

## Coding Style & Naming Conventions
Target Python `3.11+`. Follow Ruff settings in `pyproject.toml`: line length `100`, import sorting enabled, and modern Python upgrades enforced. Use 4-space indentation, `snake_case` for functions/modules, `PascalCase` for classes, and keep tool or integration filenames descriptive, for example `jira_update_issue.py` or `daytona.py`.

## Testing Guidelines
Use `pytest` with `pytest-asyncio`; async tests are supported via `asyncio_mode = "auto"`. Add unit tests under `tests/` for new middleware, tools, or utilities. Keep test filenames as `test_<feature>.py` and prefer focused test names that describe behavior. Run the narrowest relevant test file before opening a PR, then run `make test`.

## Commit & Pull Request Guidelines
Recent history favors short, imperative subjects, often with Conventional Commit prefixes such as `feat:`, `feat(jira):`, or `feat(open-sandbox):`. Keep commits scoped to one change.

PRs should explain the user-visible or operational impact, link the related issue, and note any configuration or sandbox implications. Include screenshots only for UI or webhook-facing changes, and list the validation you ran, such as `make lint` and `make test`.

## Security & Configuration Tips
Do not commit secrets, webhook payloads with credentials, or local `.env` files. Review `SECURITY.md`, `INSTALLATION.md`, and `CUSTOMIZATION.md` before changing auth, GitHub, Slack, Linear, or sandbox integrations.
