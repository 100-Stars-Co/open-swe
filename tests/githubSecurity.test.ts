import { describe, expect, it } from "bun:test";
import {
  gitCheckoutExistingBranch,
  gitPullBranch,
} from "../src/utils/github.js";

/**
 * Fake sandbox that records commands without executing them.
 */
class FakeSandbox {
  commands: string[] = [];
  writes: [string, string][] = [];

  execute(command: string) {
    this.commands.push(command);
    return { output: "", exitCode: 0, truncated: false };
  }

  write(path: string, content: string) {
    this.writes.push([path, content]);
    return { path, error: null };
  }

  // Stubs for SandboxBackendProtocol
  read(_path: string) {
    return { output: "", exitCode: 0, truncated: false };
  }
  readRaw(_path: string) {
    return { content: "", error: null };
  }
  edit(_path: string, _old: string, _new: string) {
    return { output: "", exitCode: 0 };
  }
  lsInfo(_dir: string) {
    return [];
  }
  grepRaw(_pattern: string, _path: string) {
    return { output: "", exitCode: 0 };
  }
  globInfo(_pattern: string) {
    return [];
  }
  downloadFiles(paths: string[]) {
    return paths.map((p) => ({ path: p, content: null, error: null }));
  }
  uploadFiles(files: [string, Uint8Array][]) {
    return files.map(([p]) => ({ path: p, error: null }));
  }
}

describe("git shell quoting", () => {
  it("gitCheckoutExistingBranch quotes repo dir and branch", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: fake sandbox
    const sandbox = new FakeSandbox() as any;
    const repoDir = "/tmp/repo; curl attacker";
    const branch = "main; curl attacker";

    await gitCheckoutExistingBranch(sandbox, repoDir, branch);

    expect(sandbox.commands.length).toBe(1);
    expect(sandbox.commands[0]).toContain("'/tmp/repo; curl attacker'");
    expect(sandbox.commands[0]).toContain("'main; curl attacker'");
  });

  it("gitPullBranch quotes repo dir and branch", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: fake sandbox
    const sandbox = new FakeSandbox() as any;
    const repoDir = "/tmp/repo; curl attacker";
    const branch = "main; curl attacker";

    await gitPullBranch(sandbox, repoDir, branch, "secret-token");

    expect(sandbox.commands.length).toBe(1);
    expect(sandbox.commands[0]).toContain("'/tmp/repo; curl attacker'");
    expect(sandbox.commands[0]).toContain("'main; curl attacker'");
  });
});
