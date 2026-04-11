/**
 * LangSmith (cloud) sandbox integration — default production sandbox.
 * Mirrors agent/integrations/langsmith.py
 *
 * Uses deepagents' built-in LangSmithSandbox which connects to LangSmith Cloud
 * sandboxes, providing an isolated container per thread.
 *
 * Env vars:
 *   LANGSMITH_API_KEY        — API key for LangSmith (required)
 *   LANGSMITH_API_URL        — LangSmith API URL (optional)
 *   ANTHROPIC_API_KEY          — forwarded into sandbox as env var if set
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

const DEFAULT_LANGSMITH_TIMEOUT = 300;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTimeout(timeout?: number): number {
  if (timeout !== undefined) return timeout;
  const env = process.env.SANDBOX_TIMEOUT;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (!Number.isNaN(n)) return n;
  }
  return DEFAULT_LANGSMITH_TIMEOUT;
}

function buildSandboxEnvs(): Record<string, string> {
  const envs: Record<string, string> = {};
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) envs.ANTHROPIC_API_KEY = apiKey;
  return envs;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── LangSmithBackend ─────────────────────────────────────────────────────────

/**
 * Wraps the LangSmith Sandbox in the SandboxBackendProtocol interface.
 */
export class LangSmithBackend implements SandboxBackendProtocol {
  // biome-ignore lint/suspicious/noExplicitAny: LangSmith SDK types not available at compile time
  private readonly _sandbox: any;
  private readonly _defaultTimeout: number;

  // biome-ignore lint/suspicious/noExplicitAny: LangSmith SDK types
  constructor(sandbox: any, defaultTimeout: number = DEFAULT_LANGSMITH_TIMEOUT) {
    this._sandbox = sandbox;
    this._defaultTimeout = defaultTimeout;
  }

  get id(): string {
    const sid = this._sandbox?.id ?? this._sandbox?.sandboxId;
    if (!sid) throw new Error("LangSmith sandbox did not expose an id");
    return String(sid);
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  async execute(command: string): Promise<ExecuteResponse> {
    try {
      const result = await this._sandbox.execute(command, {
        timeout: this._defaultTimeout,
      });
      return {
        output: result?.output ?? "",
        exitCode: result?.exitCode ?? 0,
        truncated: result?.truncated ?? false,
      };
    } catch (err: unknown) {
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
      if (this._sandbox?.writeFile) {
        await this._sandbox.writeFile(filePath, content);
        return { path: filePath, error: undefined };
      }
      // Fallback: use base64 encoding via execute
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
    const result = await this.execute(`ls -la ${shellQuote(path)} 2>&1 | tail -n +2`);
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
          if (this._sandbox?.readFile) {
            const content = await this._sandbox.readFile(p);
            return {
              path: p,
              content: typeof content === "string" ? new TextEncoder().encode(content) : content,
              error: null,
            } satisfies FileDownloadResponse;
          }
          const result = await this.execute(`cat ${shellQuote(p)}`);
          if (result.exitCode !== 0) {
            return {
              path: p,
              content: null,
              error: "file_not_found" as FileOperationError,
            };
          }
          return {
            path: p,
            content: new TextEncoder().encode(result.output),
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

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.all(
      files.map(async ([path, data]) => {
        try {
          const content = new TextDecoder().decode(data);
          const result = await this.write(path, content);
          return {
            path,
            error: result.error ? ("permission_denied" as FileOperationError) : null,
          } satisfies FileUploadResponse;
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
 * Create or reconnect to a LangSmith sandbox.
 */
export async function createLangsmithSandbox(
  sandboxId?: string,
  timeout?: number,
): Promise<SandboxBackendProtocol> {
  const { LangSmithSandbox } = await import("deepagents");

  const resolvedTimeout = resolveTimeout(timeout);
  const envs = buildSandboxEnvs();

  // LangSmith SDK doesn't support reconnecting to existing sandboxes by ID
  // If sandboxId is provided, we log a warning and create a new one
  if (sandboxId) {
    console.warn(
      `[langsmith] Reconnecting to existing sandbox ${sandboxId} is not supported. Creating a new sandbox.`,
    );
  }

  // Create new sandbox
  const createOpts: Record<string, unknown> = {};
  if (Object.keys(envs).length) {
    createOpts.env = envs;
  }
  // biome-ignore lint/suspicious/noExplicitAny: deepagents SDK types
  const rawSandbox: any = await LangSmithSandbox.create(createOpts);

  // Set timeout if available
  if (typeof rawSandbox.setTimeout === "function") {
    rawSandbox.setTimeout(resolvedTimeout);
  }

  return new LangSmithBackend(rawSandbox, resolvedTimeout);
}

/**
 * Permanently delete a LangSmith sandbox (called during cleanup).
 */
export async function deleteLangsmithSandbox(sandboxId: string): Promise<void> {
  try {
    // LangSmithSandbox doesn't expose a static delete; attempt via prototype if available
    const { LangSmithSandbox } = await import("deepagents");
    // biome-ignore lint/suspicious/noExplicitAny: checking for optional SDK method
    const proto = LangSmithSandbox as any;
    if (typeof proto.delete === "function") {
      await proto.delete({ id: sandboxId });
      return;
    }
    throw new Error("LangSmith sandbox deletion is not supported by the installed SDK");
  } catch (err) {
    throw new Error(
      `[langsmith] Failed to delete sandbox ${sandboxId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
