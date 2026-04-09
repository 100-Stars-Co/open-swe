/**
 * Sandbox factory registry.
 * Mirrors agent/utils/sandbox.py + agent/integrations/__init__.py
 */

import type { SandboxBackendProtocol } from "deepagents";
import { createDaytonaSandbox } from "../integrations/daytona.js";
import { createLocalSandbox } from "../integrations/local.js";
import { createOpenSandbox } from "../integrations/opensandbox.js";

export type SandboxFactory = (
  sandboxId?: string,
  timeout?: number,
) => Promise<SandboxBackendProtocol>;

export const SANDBOX_FACTORIES: Record<string, SandboxFactory> = {
  daytona: createDaytonaSandbox,
  langsmith: createDaytonaSandbox,
  opensandbox: createOpenSandbox,
  local: createLocalSandbox,
};

/**
 * Create or reconnect to a sandbox using the SANDBOX_TYPE env var.
 * Defaults to "local" for safety.
 */
export async function createSandbox(
  sandboxId?: string,
  timeout?: number,
): Promise<SandboxBackendProtocol> {
  const sandboxType = process.env.SANDBOX_TYPE ?? "local";
  const factory = SANDBOX_FACTORIES[sandboxType];

  if (!factory) {
    throw new Error(
      `Unknown SANDBOX_TYPE '${sandboxType}'. ` +
        `Supported values: ${Object.keys(SANDBOX_FACTORIES).join(", ")}`,
    );
  }

  return factory(sandboxId, timeout);
}
