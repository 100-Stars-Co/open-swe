import { describe, it, expect } from "bun:test";
import { constructSystemPrompt } from "../src/prompt.js";

describe("constructSystemPrompt", () => {
  it("includes the working directory", () => {
    const prompt = constructSystemPrompt({ workingDir: "/home/user/repos/myorg/myrepo" });
    expect(prompt).toContain("/home/user/repos/myorg/myrepo");
  });

  it("includes required sections", () => {
    const prompt = constructSystemPrompt({ workingDir: "/workspace" });
    expect(prompt).toContain("Working Environment");
    expect(prompt).toContain("File Management");
    expect(prompt).toContain("Task Execution Workflow");
    expect(prompt).toContain("Coding Standards");
    expect(prompt).toContain("Committing and Opening a PR");
  });

  it("injects Jira issue key when provided", () => {
    const prompt = constructSystemPrompt({
      workingDir: "/workspace",
      jiraProjectKey: "PROJ",
      jiraIssueKey: "PROJ-42",
    });
    expect(prompt).toContain("PROJ-42");
  });

  it("injects agentsMd section with filename when provided", () => {
    const prompt = constructSystemPrompt({
      workingDir: "/workspace",
      agentsMd: "## Custom rules\n- Always use TypeScript",
      agentsMdFilename: "CLAUDE.md",
    });
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain("Always use TypeScript");
  });

  it("does not include agentsMd section when not provided", () => {
    const prompt = constructSystemPrompt({ workingDir: "/workspace" });
    expect(prompt).not.toContain("Repository-Specific Guidelines");
  });

  it("returns a non-empty string", () => {
    const prompt = constructSystemPrompt({ workingDir: "/workspace" });
    expect(prompt.length).toBeGreaterThan(500);
  });
});
