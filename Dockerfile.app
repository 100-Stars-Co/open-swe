# Application Dockerfile — builds and runs the Open SWE agent + webhook server.
# Uses Bun as the runtime.

FROM oven/bun:1.1 AS deps

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# ─── Build stage ───────────────────────────────────────────────────────────────
FROM oven/bun:1.1 AS build

WORKDIR /app

COPY package.json bun.lockb tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src/ src/
COPY langgraph.json ./

# Type-check (no emitted files)
RUN bun run tsc --noEmit

# ─── Runtime stage ─────────────────────────────────────────────────────────────
FROM oven/bun:1.1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules node_modules/
COPY package.json bun.lockb tsconfig.json langgraph.json ./
COPY src/ src/

ENV NODE_ENV=production
EXPOSE 8000

CMD ["bun", "src/webapp.ts"]
