.PHONY: all format format-check lint test tests integration_tests help run dev server-install server-run server-dev server-typecheck

# Default target executed when no arguments are given to make.
all: help

######################
# DEVELOPMENT
######################

dev:
	langgraph dev

run: server-run

install:
	uv pip install -e .

######################
# SERVER (Hono + Bun)
######################

server-install:
	cd server && bun install

server-run:
	cd server && bun run start

server-dev:
	cd server && bun run dev

server-typecheck:
	cd server && bun run typecheck

######################
# TESTING
######################

TEST_FILE ?= tests/

test tests:
	@if [ -d "$(TEST_FILE)" ] || [ -f "$(TEST_FILE)" ]; then \
		uv run pytest -vvv $(TEST_FILE); \
	else \
		echo "Skipping tests: path not found: $(TEST_FILE)"; \
	fi

integration_tests:
	@if [ -d "tests/integration_tests/" ] || [ -f "tests/integration_tests/" ]; then \
		uv run pytest -vvv tests/integration_tests/; \
	else \
		echo "Skipping integration tests: path not found: tests/integration_tests/"; \
	fi

######################
# LINTING AND FORMATTING
######################

PYTHON_FILES=.

lint:
	uv run ruff check $(PYTHON_FILES)
	uv run ruff format $(PYTHON_FILES) --diff

format:
	uv run ruff format $(PYTHON_FILES)
	uv run ruff check --fix $(PYTHON_FILES)

format-check:
	uv run ruff format $(PYTHON_FILES) --check

######################
# HELP
######################

help:
	@echo '----'
	@echo 'dev                          - run LangGraph dev server (Python agent)'
	@echo 'run                          - run Hono webhook server (Bun)'
	@echo 'install                      - install Python dependencies'
	@echo 'server-install               - install server npm dependencies (bun install)'
	@echo 'server-run                   - run Hono webhook server'
	@echo 'server-dev                   - run Hono webhook server with hot reload'
	@echo 'server-typecheck             - typecheck the TypeScript server'
	@echo 'format                       - run code formatters'
	@echo 'lint                         - run linters'
	@echo 'test                         - run unit tests'
	@echo 'integration_tests            - run integration tests'
