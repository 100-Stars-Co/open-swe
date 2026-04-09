import { describe, expect, it } from "bun:test";

/**
 * Tests for the verifyPr tool — focused on the exported verifyPr() function.
 * We only test the early-exit / blocked paths here because the full sandbox
 * workflow requires mocking the OpenSandbox backend.
 */

describe("verifyPr", () => {
  it("returns blocked when repo config is missing", async () => {
    const { verifyPr } = await import("../src/tools/verifyPr.js");
    const result = await verifyPr(123, { repoConfig: undefined });
    expect(result.success).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.error).toContain("Missing repo owner/name");
    expect(result.pr_number).toBe(123);
    expect(result.comment_posted).toBe(false);
  });

  it("returns blocked when repo config has empty owner", async () => {
    const { verifyPr } = await import("../src/tools/verifyPr.js");
    const result = await verifyPr(123, {
      repoConfig: { owner: "", name: "testrepo" },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.error).toContain("Missing repo owner/name");
  });

  it("returns blocked when repo config has empty name", async () => {
    const { verifyPr } = await import("../src/tools/verifyPr.js");
    const result = await verifyPr(123, {
      repoConfig: { owner: "testowner", name: "" },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.error).toContain("Missing repo owner/name");
  });
});

describe("verifyPrTool schema", () => {
  it("tool is named verify_pr", async () => {
    const { verifyPrTool } = await import("../src/tools/verifyPr.js");
    expect(verifyPrTool.name).toBe("verify_pr");
  });

  it("tool has a description", async () => {
    const { verifyPrTool } = await import("../src/tools/verifyPr.js");
    expect(verifyPrTool.description.length).toBeGreaterThan(10);
  });
});
