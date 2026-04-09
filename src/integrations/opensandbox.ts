/**
 * OpenSandbox integration — self-hosted sandbox provider.
 * Mirrors agent/integrations/opensandbox.py
 *
 * OpenSandbox is an open-source sandbox runtime from Alibaba:
 * https://github.com/alibaba/OpenSandbox
 *
 * Env vars:
 *   OPENSANDBOX_URL       — server URL (default: http://localhost:9000)
 *   OPENSANDBOX_TEMPLATE  — container image (default: opensandbox/code-interpreter:v1.0.2)
 *   OPENSANDBOX_TIMEOUT   — default timeout in seconds (default: 300)
 *   OPENSANDBOX_DENY_EGRESS — set "true" to block all outbound traffic
 *   ANTHROPIC_API_KEY     — forwarded into sandbox as env var if set
 */

import type {
  SandboxBackendProtocol,
  ExecuteResponse,
  WriteResult,
  FileInfo,
  GrepMatch,
  FileDownloadResponse,
  FileUploadResponse,
  FileOperationError,
} from "deepagents";

const DEFAULT_OPENSANDBOX_URL = "http://localhost:9000";
const DEFAULT_OPENSANDBOX_TEMPLATE =
  "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2";
const DEFAULT_OPENSANDBOX_TIMEOUT = 300;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTimeout(timeout?: number): number {
  if (timeout !== undefined) return timeout;
  const env = process.env.OPENSANDBOX_TIMEOUT ?? process.env.SANDBOX_TIMEOUT;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n)) return n;
  }
  return DEFAULT_OPENSANDBOX_TIMEOUT;
}

function buildSandboxEnvs(): Record<string, string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey ? { ANTHROPIC_API_KEY: apiKey } : {};
}

/** Extract host:port from a URL string for ConnectionConfig. */
function parseServerDomain(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    return u.host; // "host:port" or "host"
  } catch {
    return serverUrl.replace(/^https?:\/\//, "");
  }
}

import net from "node:net";

/** Verify the OpenSandbox server is reachable (TCP connect). */
async function checkServerReachable(serverUrl: string): Promise<void> {
  let host = "localhost";
  let port = 9000;
  try {
    const u = new URL(serverUrl);
    host = u.hostname;
    port = parseInt(u.port || "9000", 10);
  } catch {
    // keep defaults
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve();
    });
    socket.setTimeout(3000);
    socket.on("error", (err: Error) => {
      reject(
        new Error(
          `OpenSandbox server is not reachable at ${serverUrl} (host=${host}, port=${port}). ` +
            `Ensure the server is running and OPENSANDBOX_URL is set correctly. ` +
            `Original error: ${err.message}`,
        ),
      );
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(
        new Error(
          `OpenSandbox server timed out at ${serverUrl} (host=${host}, port=${port}).`,
        ),
      );
    });
  });
}

// ─── OpenSandboxBackend ───────────────────────────────────────────────────────

/**
 * Wraps the opensandbox SDK in the SandboxBackendProtocol interface.
 *
 * The opensandbox SDK is imported dynamically so this file compiles even if
 * the optional package is not installed — an ImportError is only surfaced at
 * runtime when SANDBOX_TYPE=opensandbox.
 */
export class OpenSandboxBackend implements SandboxBackendProtocol {
  // biome-ignore lint/suspicious/noExplicitAny: opensandbox SDK types not available at compile time
  private readonly _sandbox: any;
  private readonly _defaultTimeout: number;

  // biome-ignore lint/suspicious/noExplicitAny: opensandbox SDK types not available at compile time
  constructor(sandbox: any, defaultTimeout: number) {
    this._sandbox = sandbox;
    this._defaultTimeout = defaultTimeout;
  }

  get id(): string {
    const sid = this._sandbox?.id;
    if (!sid) throw new Error("OpenSandbox did not expose an id");
    return String(sid);
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  async execute(command: string): Promise<ExecuteResponse> {
    try {
      // The opensandbox SDK exposes commands.run(cmd, opts)
      const result = await this._sandbox.commands.run(command, {
        timeout: this._defaultTimeout * 1000, // milliseconds
      });

      // Extract stdout/stderr from logs
      const stdoutMsgs: unknown[] = result?.logs?.stdout ?? [];
      const stderrMsgs: unknown[] = result?.logs?.stderr ?? [];
      const stdout = stdoutMsgs
        // biome-ignore lint/suspicious/noExplicitAny: dynamic SDK response
        .map((m: any) => m?.text ?? "")
        .join("");
      const stderr = stderrMsgs
        // biome-ignore lint/suspicious/noExplicitAny: dynamic SDK response
        .map((m: any) => m?.text ?? "")
        .join("");

      const output = [stdout, stderr].filter(Boolean).join("\n");
      const exitCode: number = result?.exit_code ?? 0;

      return { output, exitCode, truncated: false };
    } catch (err) {
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
      // Use the SDK's file write if available
      if (this._sandbox?.files?.write_files) {
        await this._sandbox.files.write_files([
          { path: filePath, data: new TextEncoder().encode(content), mode: 0o644 },
        ]);
        return { path: filePath, error: undefined };
      }
      // Fallback: use tee via execute
      const encoded = Buffer.from(content).toString("base64");
      const result = await this.execute(
        `echo ${shellQuote(encoded)} | base64 -d > ${shellQuote(filePath)}`,
      );
      if (result.exitCode !== 0) {
        return { path: filePath, error: result.output };
      }
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
      return { error: `String not found in ${filePath}`, path: filePath, occurrences: 0 };
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
          size: parseInt(parts[4] ?? "0", 10) || 0,
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
          line: parseInt(lineNum ?? "0", 10),
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

  // Optional bulk file operations
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return Promise.all(
      paths.map(async (p) => {
        try {
          if (this._sandbox?.files?.read_file) {
            const content = await this._sandbox.files.read_file(p);
            return {
              path: p,
              content: typeof content === "string" ? new TextEncoder().encode(content) : content,
              error: null,
            } satisfies FileDownloadResponse;
          }
          const result = await this.read(p);
          return { path: p, content: new TextEncoder().encode(result), error: null } satisfies FileDownloadResponse;
        } catch {
          return { path: p, content: null, error: "file_not_found" as FileOperationError } satisfies FileDownloadResponse;
        }
      }),
    );
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.all(
      files.map(async ([path, data]) => {
        const content = new TextDecoder().decode(data);
        const result = await this.write(path, content);
        return {
          path,
          error: result.error ? ("permission_denied" as FileOperationError) : null,
        } satisfies FileUploadResponse;
      }),
    );
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create or reconnect to an OpenSandbox sandbox.
 */
export async function createOpenSandbox(
  sandboxId?: string,
  timeout?: number,
): Promise<SandboxBackendProtocol> {
  let Sandbox: { create: Function; connect: Function };
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  let ConnectionConfig: any;

  try {
    // biome-ignore lint/suspicious/noExplicitAny: optional peer dependency
    const sdk = await import("opensandbox" as any);
    Sandbox = sdk.Sandbox;
    ConnectionConfig = sdk.ConnectionConfig ?? sdk.config?.ConnectionConfig;
  } catch {
    throw new Error(
      "OpenSandbox requires the 'opensandbox' npm package. " +
        "Install it with: pnpm add opensandbox",
    );
  }

  const serverUrl = process.env.OPENSANDBOX_URL ?? DEFAULT_OPENSANDBOX_URL;
  const template = process.env.OPENSANDBOX_TEMPLATE ?? DEFAULT_OPENSANDBOX_TEMPLATE;
  const resolvedTimeout = resolveTimeout(timeout);
  const envs = buildSandboxEnvs();

  // Fail fast if server is not reachable
  await checkServerReachable(serverUrl);

  const domain = parseServerDomain(serverUrl);
  const connectionConfig = new ConnectionConfig({ domain, useServerProxy: true });

  // biome-ignore lint/suspicious/noExplicitAny: dynamic SDK
  let rawSandbox: any;

  if (sandboxId) {
    rawSandbox = await Sandbox.connect(sandboxId, { connection_config: connectionConfig });
  } else {
    const denyEgress = ["1", "true", "yes"].includes(
      (process.env.OPENSANDBOX_DENY_EGRESS ?? "").toLowerCase(),
    );

    const createOpts: Record<string, unknown> = {
      image: template,
      timeout: resolvedTimeout * 1000, // ms
      connection_config: connectionConfig,
    };

    if (denyEgress) {
      createOpts.network_policy = { default_action: "deny" };
    }

    if (Object.keys(envs).length) {
      createOpts.env = envs;
    }

    rawSandbox = await Sandbox.create(createOpts);
  }

  return new OpenSandboxBackend(rawSandbox, resolvedTimeout) as unknown as SandboxBackendProtocol;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
