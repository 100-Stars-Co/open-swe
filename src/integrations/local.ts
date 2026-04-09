/**
 * Local sandbox integration — for development only.
 * Uses deepagents' built-in LocalShellBackend which runs commands on the host.
 * Mirrors agent/integrations/local.py
 *
 * WARNING: Never use in production — runs commands directly on the host machine.
 */

import { LocalShellBackend } from "deepagents";
import type { SandboxBackendProtocol } from "deepagents";

/**
 * Create a local sandbox backend.
 * sandboxId and timeout are ignored (no remote API involved).
 */
export async function createLocalSandbox(
  _sandboxId?: string,
  _timeout?: number,
): Promise<SandboxBackendProtocol> {
  return new LocalShellBackend() as unknown as SandboxBackendProtocol;
}
