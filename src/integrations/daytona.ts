/**
 * Daytona sandbox integration.
 * Mirrors agent/integrations/daytona.py
 *
 * Daytona is a cloud sandbox provider for running code:
 * https://www.daytona.io
 *
 * Env vars:
 *   DAYTONA_API_KEY       — API key for Daytona (optional, uses SDK default)
 *   DAYTONA_API_URL       — Daytona server URL (default: https://app.daytona.io/api)
 *   DAYTONA_TARGET        — Target environment for sandboxes (default: us)
 *   DAYTONA_SNAPSHOT      — Snapshot name used to create sandboxes (default: daytona-medium)
 *   SANDBOX_TIMEOUT       — default timeout in seconds (default: 300)
 *   ANTHROPIC_API_KEY     — forwarded into sandbox as env var if set
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

const DEFAULT_DAYTONA_TIMEOUT = 300;
const DEFAULT_DAYTONA_API_URL = "https://app.daytona.io/api";
const DEFAULT_DAYTONA_TARGET = "us";
const DEFAULT_DAYTONA_SNAPSHOT = "daytona-medium";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTimeout(timeout?: number): number {
  if (timeout !== undefined) return timeout;
  const env = process.env.SANDBOX_TIMEOUT;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (!Number.isNaN(n)) return n;
  }
  return DEFAULT_DAYTONA_TIMEOUT;
}

function buildSandboxEnvs(): Record<string, string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey ? { ANTHROPIC_API_KEY: apiKey } : {};
}

function resolveSnapshotName(): string {
  return process.env.DAYTONA_SNAPSHOT ?? DEFAULT_DAYTONA_SNAPSHOT;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n");
}

// ─── DaytonaBackend ───────────────────────────────────────────────────────────

export class DaytonaBackend implements SandboxBackendProtocol {
  // biome-ignore lint/suspicious/noExplicitAny: Daytona SDK types not available at compile time
  private readonly _sandbox: any;
  private readonly _defaultTimeout: number;

  // biome-ignore lint/suspicious/noExplicitAny: Daytona SDK types
  constructor(sandbox: any, defaultTimeout: number = DEFAULT_DAYTONA_TIMEOUT) {
    this._sandbox = sandbox;
    this._defaultTimeout = defaultTimeout;
  }

  get id(): string {
    const sid = this._sandbox?.id;
    if (!sid) throw new Error("Daytona sandbox did not expose an id");
    return String(sid);
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  async execute(command: string): Promise<ExecuteResponse> {
    try {
      const result = await this._sandbox.process.executeCommand(
        command,
        undefined,
        undefined,
        this._defaultTimeout,
      );
      const output = combineOutput(
        result?.artifacts?.stdout ?? "",
        result?.artifacts?.stderr ?? "",
      );
      return { output, exitCode: result?.exitCode ?? 0, truncated: false };
    } catch (err: unknown) {
      const exitCode = (err as Record<string, unknown>)?.exitCode as number | undefined;
      if (exitCode !== undefined) {
        const stdout = ((err as Record<string, unknown>)?.stdout as string) ?? "";
        const stderr = ((err as Record<string, unknown>)?.stderr as string) ?? "";
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
    try {
      const buffer = await this._sandbox.fs.downloadFile(filePath);
      return { content: new Uint8Array(buffer), mime_type: "text/plain" };
    } catch {
      const text = await this.read(filePath);
      return { content: new TextEncoder().encode(text), mime_type: "text/plain" };
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const buffer = Buffer.from(content, "utf-8");
      await this._sandbox.fs.uploadFile(buffer, filePath);
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
    try {
      const files = await this._sandbox.fs.listFiles(path);
      return files.map(
        // biome-ignore lint/suspicious/noExplicitAny: Daytona SDK FileInfo
        (file: any) =>
          ({
            path: `${path.replace(/\/$/, "")}/${file.name}`,
            size: file.size ?? 0,
            is_dir: file.isDir ?? false,
            modified_at: file.modTime,
          }) satisfies FileInfo,
      );
    } catch {
      // Fallback to execute
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
  }

  async grepRaw(
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ): Promise<GrepMatch[] | string> {
    try {
      const searchPath = path ?? ".";
      const matches = (await this._sandbox.fs.findFiles(searchPath, pattern)) as Array<{
        file: string;
        line: number;
        content: string;
      }>;
      return matches.map(
        (match) =>
          ({
            path: match.file,
            line: match.line,
            text: match.content,
          }) satisfies GrepMatch,
      );
    } catch {
      // Fallback to execute
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
  }

  async globInfo(pattern: string, path = "/"): Promise<FileInfo[]> {
    try {
      const result = await this._sandbox.fs.searchFiles(path, pattern);
      return (
        result.files?.map(
          // biome-ignore lint/suspicious/noExplicitAny: Daytona SDK FileInfo
          (file: any) =>
            ({
              path: file,
              size: 0,
              is_dir: false,
            }) satisfies FileInfo,
        ) ?? []
      );
    } catch {
      // Fallback to execute
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
        }));
    }
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return Promise.all(
      paths.map(async (p) => {
        try {
          const content = await this._sandbox.fs.downloadFile(p);
          return {
            path: p,
            content: new Uint8Array(content),
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
          await this._sandbox.fs.uploadFile(Buffer.from(data), path);
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
 * Create or reconnect to a Daytona sandbox.
 */
export async function createDaytonaSandbox(
  sandboxId?: string,
  timeout?: number,
): Promise<SandboxBackendProtocol> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import from optional peer dep
  let Daytona: any;

  try {
    const sdk = await import("@daytona/sdk" as never);
    Daytona = sdk.Daytona;
  } catch {
    throw new Error(
      "Daytona requires the '@daytona/sdk' npm package. Install it with: bun add @daytona/sdk",
    );
  }

  const apiKey = process.env.DAYTONA_API_KEY;
  const apiUrl = process.env.DAYTONA_API_URL ?? DEFAULT_DAYTONA_API_URL;
  const target = process.env.DAYTONA_TARGET ?? DEFAULT_DAYTONA_TARGET;
  const resolvedTimeout = resolveTimeout(timeout);
  const envs = buildSandboxEnvs();

  const daytona = new Daytona({
    apiKey,
    apiUrl,
    target,
  });

  // biome-ignore lint/suspicious/noExplicitAny: Daytona Sandbox
  let sandbox: any;

  if (sandboxId) {
    sandbox = await daytona.get(sandboxId);
    // Ensure sandbox is started
    if (sandbox.state !== "started") {
      await daytona.start(sandbox);
    }
  } else {
    const createOpts: Record<string, unknown> = {
      language: "typescript",
      snapshot: resolveSnapshotName(),
      envVars: envs,
      autoStopInterval: Math.ceil(resolvedTimeout / 60), // Convert seconds to minutes
    };

    sandbox = await daytona.create(createOpts, { timeout: resolvedTimeout });
  }

  return new DaytonaBackend(sandbox, resolvedTimeout);
}

/**
 * Permanently delete a Daytona sandbox (called during cleanup).
 */
export async function deleteDaytonaSandbox(sandboxId: string): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  let Daytona: any;

  try {
    const sdk = await import("@daytona/sdk" as never);
    Daytona = sdk.Daytona;
  } catch (err) {
    throw new Error(
      `[@daytona/sdk] not installed, cannot delete sandbox ${sandboxId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const apiKey = process.env.DAYTONA_API_KEY;
    const apiUrl = process.env.DAYTONA_API_URL ?? DEFAULT_DAYTONA_API_URL;
    const target = process.env.DAYTONA_TARGET ?? DEFAULT_DAYTONA_TARGET;

    const daytona = new Daytona({
      apiKey,
      apiUrl,
      target,
    });

    const sandbox = await daytona.get(sandboxId);
    await daytona.delete(sandbox);
  } catch (err) {
    throw new Error(
      `[daytona-sandbox] Failed to delete sandbox ${sandboxId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
