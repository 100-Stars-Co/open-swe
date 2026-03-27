/**
 * Entry point — starts the Hono server with Bun.serve().
 * Run with: bun --env-file=../.env src/index.ts
 */

import { config } from "./utils/config.ts";
import { app } from "./app.ts";

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
});

console.log(`Open SWE webhook server running on http://localhost:${server.port}`);
