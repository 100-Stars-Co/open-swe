# Gemini Context: Open SWE (JS/TS)

This project is a TypeScript/Node.js implementation of **Open SWE**, an open-source framework for building internal coding agents. It is built on top of [LangGraph](https://langchain-ai.github.io/langgraph/) and [Deep Agents](https://github.com/langchain-ai/deepagents).

## Project Overview

- **Purpose:** Provide an extensible architecture for creating coding agents that can handle GitHub issues, Jira tickets, and Telegram messages autonomously.
- **Architecture:**
  - **Agent Server (`src/server.ts`):** The main entry point for LangGraph. It initializes a `DeepAgent` with a rich system prompt, custom tools, and middleware.
  - **Webhook Server (`src/webapp.ts`):** A Hono-based HTTP server that listens for webhooks from GitHub, Jira, and Telegram to trigger agent runs.
  - **Sandboxes:** Every task runs in an isolated environment (remote Linux cloud sandbox or local). Supported providers include Daytona, E2B, OpenSandbox, and Local.
  - **Tools:** Specialized tools for shell execution, file management, Git operations (commit/PR), Jira interaction, and Telegram communication.
  - **Middleware:** Structured hooks that run around the agent loop to handle errors, queue follow-up messages, and ensure PRs are opened.

## Building and Running

The project uses `bun` as its primary runtime and package manager.

### Key Commands

- **Install Dependencies:**
  ```bash
  bun install
  ```
- **Run LangGraph Dev Server:**
  ```bash
  bun run dev
  # or
  langgraphjs dev --port 2024
  ```
- **Run Webhook Server:**
  ```bash
  bun run src/webapp.ts
  # or
  make run
  ```
- **Testing:**
  ```bash
  bun test
  ```
- **Linting & Formatting:**
  ```bash
  bun run lint
  bun run format
  ```
- **Build/Type-check:**
  ```bash
  bun run build
  ```

## Development Conventions

### Agent Behavior & Context
- **`AGENTS.md` / `CLAUDE.md`:** The agent automatically reads these files from the root of the target repository to learn project-specific conventions, testing requirements, and architectural rules.
- **System Prompt:** Assembled in `src/prompt.ts`. It enforces a **Understand -> Plan -> Implement -> Verify -> Submit** workflow.
- **Persistence:** The agent is instructed to be persistent and autonomous, attempting alternatives if a first approach fails.

### Code Style
- **TypeScript:** The codebase is written in strict TypeScript.
- **Biome:** Used for linting and formatting. Configuration is in `biome.json`.
- **Imports:** Uses ES modules with `.js` extensions in imports (required by Node.js for TS projects with `"type": "module"`).

### Repository Structure
- `src/tools/`: Custom tool implementations.
- `src/middleware/`: LangGraph middleware logic.
- `src/integrations/`: Third-party sandbox provider integrations.
- `src/utils/`: Shared utilities for authentication, Git, and sandbox state management.
- `tests/`: Vitest-based unit and integration tests.

## Environment Variables

Key variables required (see `.env.example` for full list):
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`: For the LLM.
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`: For GitHub integration.
- `SANDBOX_TYPE`: e.g., `daytona`, `e2b`, `local`.
- `LANGGRAPH_API_URL`: URL of the LangGraph server.
