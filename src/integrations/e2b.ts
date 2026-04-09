/**
 * E2B sandbox integration.
 * Mirrors agent/integrations/e2b.py
 *
 * E2B is a cloud sandbox provider for running code:
 * https://e2b.dev
 *
 * Env vars:
 *   E2B_API_KEY       — API key for E2B (optional, defaults to SDK default)
 *   E2B_TEMPLATE      — sandbox template (default: "opencode")
 *   SANDBOX_TIMEOUT   — default timeout in seconds (default: 300)
 *   ANTHROPIC_API_KEY — forwarded into sandbox as env var if set
 */

import type {
  ExecuteResponse,
  FileDownloadResponse,
  FileInfo,
  FileOperationError,
  FileUploadResponse,
  GrepMatch,
  SandboxBackendProtocol,
  WriteResult,
} from "deepagents";

const DEFAULT_E2B_TEMPLATE = "opencode";
const DEFAULT_E2B_TIMEOUT = 300;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTimeout(timeout?: number): number {
  if (timeout !== undefined) return timeout;
  const env = process.env.SANDBOX_TIMEOUT;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (!Number.isNaN(n)) return n;
  }
  return DEFAULT_E2B_TIMEOUT;
}

function buildSandboxEnvs(): Record<string, string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey ? { ANTHROPIC_API_KEY: apiKey } : {};
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n");
}

// ─── E2BBackend ───────────────────────────────────────────────────────────────

export class E2BBackend implements SandboxBackendProtocol {
  // biome-ignore lint/suspicious/noExplicitAny: E2B SDK types not available at compile time
  private readonly _sandbox: any;
  private readonly _defaultTimeout: number;

  // biome-ignore lint/suspicious/noExplicitAny: E2B SDK types
  constructor(sandbox: any, defaultTimeout: number = DEFAULT_E2B_TIMEOUT) {
    this._sandbox = sandbox;
    this._defaultTimeout = defaultTimeout;
  }

  get id(): string {
    const sid = this._sandbox?.sandboxId ?? this._sandbox?.id;
    if (!sid) throw new Error("E2B sandbox did not expose an id");
    return String(sid);
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  async execute(command: string): Promise<ExecuteResponse> {
    try {
      const result = await this._sandbox.commands.run(command, {
        timeout: this._defaultTimeout,
      });
      const output = combineOutput(result?.stdout ?? "", result?.stderr ?? "");
      return { output, exitCode: result?.exitCode ?? 0, truncated: false };
    } catch (err: unknown) {
      const exitCode = (err as Record<string, unknown>)?.exitCode as
        | number
        | undefined;
      if (exitCode !== undefined) {
        const stdout =
          ((err as Record<string, unknown>)?.stdout as string) ?? "";
        const stderr =
          ((err as Record<string, unknown>)?.stderr as string) ?? "";
        const output = combineOutput(stdout, stderr) || String(err);
        return { output, exitCode, truncated: false };
      }
      return {
        output: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        truncated: false,
      };
    }
  }

  // ─── File operations ───────────────────────────────────────────────────────

  async read(filePath: string, offset = 0, limit = 500): Promise<string> {
    try {
      const result = await this.execute(
        `sed -n '${offset + 1},${offset + limit}p' ${shellQuote(filePath)}`,
      );
      return result.output;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: generic FileData
  async readRaw(filePath: string): Promise<any> {
    const text = await this.read(filePath);
    return { content: new TextEncoder().encode(text), mime_type: "text/plain" };
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      await this._sandbox.files.write(filePath, content);
      return { path: filePath, error: undefined };
    } catch (err) {
      return {
        path: filePath,
        error: `Failed to write file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
    // biome-ignore lint/suspicious/noExplicitAny: EditResult from deepagents
  ): Promise<any> {
    const content = await this.read(filePath);
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) {
      return {
        error: `String not found in ${filePath}`,
        path: filePath,
        occurrences: 0,
      };
    }
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    const writeResult = await this.write(filePath, updated);
    return {
      error: writeResult.error,
      path: filePath,
      occurrences: replaceAll ? occurrences : 1,
    };
  }

  async lsInfo(path: string): Promise<FileInfo[]> {
    const result = await this.execute(
      `ls -la ${shellQuote(path)} 2>&1 | tail -n +2`,
    );
    if (result.exitCode !== 0) return [];
    return result.output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        const name = parts[parts.length - 1] ?? "";
        const isDir = line.startsWith("d");
        return {
          path: `${path.replace(/\/$/, "")}/${name}${isDir ? "/" : ""}`,
          size: Number.parseInt(parts[4] ?? "0", 10) || 0,
          is_dir: isDir,
        } satisfies FileInfo;
      });
  }

  async grepRaw(
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ): Promise<GrepMatch[] | string> {
    const pathArg = path ? shellQuote(path) : ".";
    const globArg = glob ? `--include=${shellQuote(glob)}` : "";
    const result = await this.execute(
      `grep -rn ${globArg} ${shellQuote(pattern)} ${pathArg} 2>/dev/null`,
    );
    if (result.exitCode !== 0) return [];
    return result.output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [file, lineNum, ...rest] = line.split(":");
        return {
          path: file ?? "",
          line: Number.parseInt(lineNum ?? "0", 10),
          text: rest.join(":"),
        } satisfies GrepMatch;
      });
  }

  async globInfo(pattern: string, path = "/"): Promise<FileInfo[]> {
    const result = await this.execute(
      `find ${shellQuote(path)} -path ${shellQuote(pattern)} 2>/dev/null`,
    );
    if (result.exitCode !== 0) return [];
    return result.output
      .split("\n")
      .filter(Boolean)
      .map((p) => ({
        path: p,
        size: 0,
        is_dir: false,
        last_modified: "",
        mime_type: "application/octet-stream",
      }));
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return Promise.all(
      paths.map(async (p) => {
        try {
          const content = await this._sandbox.files.read(p);
          return {
            path: p,
            content,
            error: null,
          } satisfies FileDownloadResponse;
        } catch {
          return {
            path: p,
            content: null,
            error: "file_not_found" as FileOperationError,
          } satisfies FileDownloadResponse;
        }
      }),
    );
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    return Promise.all(
      files.map(async ([path, data]) => {
        try {
          const content = new TextDecoder().decode(data);
          await this._sandbox.files.write(path, content);
          return { path, error: null } satisfies FileUploadResponse;
        } catch (_err) {
          return {
            path,
            error: "permission_denied" as FileOperationError,
          } satisfies FileUploadResponse;
        }
      }),
    );
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create or reconnect to an E2B sandbox.
 */
export async function createE2bSandbox(
  sandboxId?: string,
  timeout?: number,
): Promise<SandboxBackendProtocol> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import from optional peer dep
  let Sandbox: any;

  try {
    const sdk = await import("e2b" as never);
    Sandbox = sdk.Sandbox;
  } catch {
    throw new Error(
      "E2B requires the 'e2b' npm package. Install it with: bun add e2b",
    );
  }

  const template = process.env.E2B_TEMPLATE ?? DEFAULT_E2B_TEMPLATE;
  const resolvedTimeout = resolveTimeout(timeout);
  const envs = buildSandboxEnvs();
  const apiKey = process.env.E2B_API_KEY;

  // biome-ignore lint/suspicious/noExplicitAny: dynamic SDK
  let rawSandbox: any;

  if (sandboxId) {
    rawSandbox = await Sandbox.connect(sandboxId);
    if (typeof rawSandbox.setTimeout === "function") {
      rawSandbox.setTimeout(resolvedTimeout);
    }
  } else {
    const opts: Record<string, unknown> = {
      template,
      timeout: resolvedTimeout,
    };
    if (apiKey) opts.apiKey = apiKey;
    if (Object.keys(envs).length) opts.envs = envs;
    rawSandbox = await Sandbox.create(opts);
  }

  return new E2BBackend(rawSandbox, resolvedTimeout);
}
