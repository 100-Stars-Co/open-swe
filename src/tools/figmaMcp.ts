/**
 * Figma MCP tools for accessing Figma design files.
 * Mirrors agent/tools/figma_mcp.py
 *
 * Uses the figma-developer-mcp npm package launched via stdio transport.
 * Set FIGMA_API_KEY to a Figma Personal Access Token to enable the tools.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Spawn a figma-developer-mcp process and invoke a tool by name.
 * Uses child_process since MCP stdio transport is process-based.
 */
async function invokeFigmaTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
  const figmaApiKey = process.env.FIGMA_API_KEY ?? "";

  const client = new MultiServerMCPClient({
    figma: {
      transport: "stdio",
      command: "npx",
      args: [
        "-y",
        "figma-developer-mcp",
        `--figma-api-key=${figmaApiKey}`,
        "--stdio",
      ],
    },
  });

  try {
    const tools = await client.getTools();
    const target = tools.find((t: { name: string }) => t.name === toolName);
    if (!target) {
      throw new Error(
        `${toolName} tool not available from figma-developer-mcp`,
      );
    }
    return await target.invoke(args);
  } finally {
    // MCP client may have a close method; if so, call it
    if (
      typeof (client as unknown as Record<string, unknown>).close === "function"
    ) {
      await (client as unknown as { close: () => Promise<void> }).close();
    }
  }
}

function unwrapException(e: unknown): string {
  if (e instanceof Error) {
    // Handle AggregateError / ExceptionGroup
    if ("errors" in e && Array.isArray((e as { errors: Error[] }).errors)) {
      return (e as { errors: Error[] }).errors
        .map((sub) => sub.message)
        .join("; ");
    }
    return e.message;
  }
  return String(e);
}

// ─── figma_get_file ──────────────────────────────────────────────────────────

const getFileSchema = z.object({
  fileKey: z
    .string()
    .describe(
      'The Figma file key (from the URL, e.g. "ABC123" in figma.com/file/ABC123/...). Also accepts a full Figma URL.',
    ),
  nodeId: z
    .string()
    .optional()
    .describe(
      "Optional node ID to scope the fetch to a specific frame or component (e.g. '1:23').",
    ),
  depth: z
    .number()
    .int()
    .optional()
    .describe("Optional depth limit for nested elements."),
});

export const figmaGetFile = tool(
  async ({ fileKey, nodeId, depth }, _config: RunnableConfig) => {
    try {
      const args: Record<string, unknown> = { fileKey };
      if (nodeId) args.nodeId = nodeId;
      if (depth !== undefined) args.depth = depth;

      const document = await invokeFigmaTool("get_figma_data", args);
      return JSON.stringify({ success: true, document });
    } catch (e) {
      return JSON.stringify({
        success: false,
        error: `Failed to get Figma file: ${unwrapException(e)}`,
      });
    }
  },
  {
    name: "figma_get_file",
    description:
      "Get a Figma file's layout and styling information. " +
      "Retrieves design information including layout structure, colors, typography, and component details.",
    schema: getFileSchema,
  },
);

// ─── figma_get_component ─────────────────────────────────────────────────────

const getComponentSchema = z.object({
  fileKey: z.string().describe("The Figma file key containing the component."),
  componentId: z
    .string()
    .describe("The node ID of the component (e.g. '1:23')."),
});

export const figmaGetComponent = tool(
  async ({ fileKey, componentId }, _config: RunnableConfig) => {
    try {
      const result = await invokeFigmaTool("get_figma_data", {
        fileKey,
        nodeId: componentId,
      });
      return JSON.stringify({ success: true, component: result });
    } catch (e) {
      return JSON.stringify({
        success: false,
        error: `Failed to get Figma component: ${unwrapException(e)}`,
      });
    }
  },
  {
    name: "figma_get_component",
    description:
      "Get detailed information about a specific Figma component or frame, " +
      "including layout, styling, and variant information.",
    schema: getComponentSchema,
  },
);

// ─── figma_export_image ──────────────────────────────────────────────────────

const exportImageSchema = z.object({
  fileKey: z.string().describe("The Figma file key."),
  nodeId: z.string().describe("The node ID to export (e.g. '1:23')."),
  localPath: z
    .string()
    .default("/tmp/figma_images")
    .describe("Sandbox directory to write the image into."),
  fileName: z
    .string()
    .default("export.png")
    .describe('Output file name including extension, e.g. "button.svg".'),
});

export const figmaExportImage = tool(
  async ({ fileKey, nodeId, localPath, fileName }, _config: RunnableConfig) => {
    try {
      const result = await invokeFigmaTool("download_figma_images", {
        fileKey,
        nodes: [{ nodeId, fileName }],
        localPath,
      });
      return JSON.stringify({ success: true, result });
    } catch (e) {
      return JSON.stringify({
        success: false,
        error: `Failed to export image: ${unwrapException(e)}`,
      });
    }
  },
  {
    name: "figma_export_image",
    description:
      "Download a Figma node (frame, component, or icon) as an image file. " +
      "Downloads the specified node as SVG or PNG into a local directory.",
    schema: exportImageSchema,
  },
);
