import { ensureAgentStateStoreReady } from "../state/index.js";

async function main(): Promise<void> {
  await ensureAgentStateStoreReady();
  console.log("[openswe-js] Agent state store is ready");
}

await main();
