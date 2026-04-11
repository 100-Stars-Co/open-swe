TEST_FILE ?= tests/

.PHONY: all install dev run worker build test lint format format-check clean help

all: help

######################
# DEVELOPMENT
######################

install:
	bun install

dev:
	bun run --watch src/index.ts

run:
	bun run src/index.ts

worker:
	bun run src/worker.ts

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
	@echo 'dev                          - run API server in watch mode'
	@echo 'run                          - run API server'
	@echo 'worker                       - run background worker'
	@echo 'install                      - install dependencies'
	@echo 'format                       - run code formatters'
	@echo 'lint                         - run linters'
	@echo 'test                         - run unit tests'
