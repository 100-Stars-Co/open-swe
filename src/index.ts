import { ensureAgentStateStoreReady } from "./state/index.js";
import { app } from "./webapp.js";

await ensureAgentStateStoreReady();

const PORT = Number.parseInt(process.env.PORT ?? "8000", 10);

Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`[openswe-js] API server running at http://localhost:${PORT}`);
