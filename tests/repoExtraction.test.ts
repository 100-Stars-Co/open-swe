import { describe, expect, it } from "bun:test";
import { extractRepoFromTextFull } from "../src/utils/repo.js";

describe("extractRepoFromTextFull", () => {
  it("parses repo:owner/name format", () => {
    const result = extractRepoFromTextFull("please use repo:my-org/my-repo");
    expect(result).toEqual({ owner: "my-org", name: "my-repo" });
  });

  it("parses repo owner/name with space", () => {
    const result = extractRepoFromTextFull("please use repo langchain-ai/langchainjs");
    expect(result).toEqual({ owner: "langchain-ai", name: "langchainjs" });
  });

  it("uses default owner for repo:name-only (colon)", () => {
    const result = extractRepoFromTextFull("fix bug in repo:langchainplus");
    expect(result).toEqual({ owner: "langchain-ai", name: "langchainplus" });
  });

  it("uses default owner for repo name-only (space)", () => {
    const result = extractRepoFromTextFull("fix bug in repo open-swe");
    expect(result).toEqual({ owner: "langchain-ai", name: "open-swe" });
  });

  it("allows custom default owner", () => {
    const result = extractRepoFromTextFull("repo:my-repo", "custom-org");
    expect(result).toEqual({ owner: "custom-org", name: "my-repo" });
  });

  it("extracts repo from GitHub URL", () => {
    const result = extractRepoFromTextFull(
      "check https://github.com/langchain-ai/langgraph-api please",
    );
    expect(result).toEqual({ owner: "langchain-ai", name: "langgraph-api" });
  });

  it("prefers explicit repo: over GitHub URL", () => {
    const result = extractRepoFromTextFull(
      "see https://github.com/langchain-ai/langgraph-api but use repo:my-org/my-repo",
    );
    expect(result).toEqual({ owner: "my-org", name: "my-repo" });
  });

  it("returns null when no repo found", () => {
    expect(extractRepoFromTextFull("please fix the bug")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractRepoFromTextFull("")).toBeNull();
  });

  it("strips trailing slash", () => {
    const result = extractRepoFromTextFull("repo:my-org/my-repo/");
    expect(result).toEqual({ owner: "my-org", name: "my-repo" });
  });
});
