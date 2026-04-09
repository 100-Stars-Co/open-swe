TEST_FILE ?= tests/

.PHONY: all install dev run build test lint format format-check clean help

all: help

######################
# DEVELOPMENT
######################

install:
	bun install

dev:
	bunx langgraph dev --port 2024

run:
	bun src/webapp.ts

build:
	bun run tsc --noEmit

######################
# TESTING
######################

test:
	bun test $(TEST_FILE)

######################
# LINTING AND FORMATTING
######################

lint:
	bunx biome check src tests

format:
	bunx biome format --write src tests
	bunx biome check --write src tests

format-check:
	bunx biome format src tests

######################
# HELP
######################

help:
	@echo '----'
	@echo 'dev                          - run LangGraph dev server'
	@echo 'run                          - run webhook server'
	@echo 'install                      - install dependencies'
	@echo 'format                       - run code formatters'
	@echo 'lint                         - run linters'
	@echo 'test                         - run unit tests'
