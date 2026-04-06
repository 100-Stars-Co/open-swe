"""Figma MCP tools for accessing Figma design files.

This module provides tools to interact with Figma design files via the
Framelink MCP server (https://github.com/GLips/Figma-Context-MCP).
Uses the `figma-developer-mcp` npm package launched via stdio transport,
so no persistent HTTP connection is required.

Set FIGMA_API_KEY to a Figma Personal Access Token to enable the tools.
"""

import os
from typing import Any

from langchain_mcp_adapters.client import MultiServerMCPClient


def _unwrap_exception(e: Exception) -> str:
    """Extract a readable message from a plain or grouped exception."""
    if isinstance(e, BaseExceptionGroup):
        return "; ".join(str(sub) for sub in e.exceptions)
    return str(e)


def _make_client() -> MultiServerMCPClient:
    """Create a MultiServerMCPClient that spawns figma-developer-mcp via stdio."""
    figma_api_key = os.environ.get("FIGMA_API_KEY", "")
    return MultiServerMCPClient(
        {
            "figma": {
                "transport": "stdio",
                "command": "npx",
                "args": [
                    "-y",
                    "figma-developer-mcp",
                    f"--figma-api-key={figma_api_key}",
                    "--stdio",
                ],
            }
        }
    )


async def _get_tool(tool_name: str) -> Any | None:
    """Spawn the figma-developer-mcp process and return the named tool."""
    tools = await _make_client().get_tools()
    return next((t for t in tools if t.name == tool_name), None)


async def figma_get_file(
    file_key: str,
    node_id: str | None = None,
    depth: int | None = None,
) -> dict[str, Any]:
    """Get a Figma file's layout and styling information.

    Retrieves design information from a Figma file, including layout structure,
    colors, typography, and component details. The response is simplified by
    figma-developer-mcp to include only the most relevant information.

    Args:
        file_key: The Figma file key (from the URL, e.g. "ABC123" in
            figma.com/file/ABC123/file-name). Also accepts a full Figma URL.
        node_id: Optional node ID to scope the fetch to a specific frame or
            component (e.g. "1:23").
        depth: Optional depth limit for nested elements (reduces response size
            for large files).

    Returns:
        Dictionary with keys:
        - success: Whether the request succeeded
        - document: Simplified layout and styling data
        - error: Error message if the request failed
    """
    try:
        tool = await _get_tool("get_figma_data")
        if not tool:
            return {
                "error": "get_figma_data tool not available from figma-developer-mcp",
                "success": False,
            }

        args: dict[str, Any] = {"fileKey": file_key}
        if node_id:
            args["nodeId"] = node_id
        if depth is not None:
            args["depth"] = depth

        result = await tool.ainvoke(args)
        return {"success": True, "document": result}

    except Exception as e:
        return {
            "error": f"Failed to get Figma file: {_unwrap_exception(e)}",
            "success": False,
        }


async def figma_get_component(
    file_key: str,
    component_id: str,
) -> dict[str, Any]:
    """Get detailed information about a specific Figma component or frame.

    Uses the node ID to scope the Figma data fetch to a single component,
    returning its layout, styling, and variant information.

    Args:
        file_key: The Figma file key containing the component.
        component_id: The node ID of the component (e.g. "1:23").

    Returns:
        Dictionary with keys:
        - success: Whether the request succeeded
        - component: Component layout and styling data
        - error: Error message if the request failed
    """
    try:
        tool = await _get_tool("get_figma_data")
        if not tool:
            return {
                "error": "get_figma_data tool not available from figma-developer-mcp",
                "success": False,
            }

        result = await tool.ainvoke({"fileKey": file_key, "nodeId": component_id})
        return {"success": True, "component": result}

    except Exception as e:
        return {
            "error": f"Failed to get Figma component: {_unwrap_exception(e)}",
            "success": False,
        }


async def figma_export_image(
    file_key: str,
    node_id: str,
    local_path: str = "/tmp/figma_images",
    file_name: str = "export.png",
) -> dict[str, Any]:
    """Download a Figma node (frame, component, or icon) as an image file.

    Downloads the specified node as SVG or PNG into a local directory inside
    the sandbox. Use the file path returned to reference the asset in code.

    Args:
        file_key: The Figma file key.
        node_id: The node ID to export (e.g. "1:23").
        local_path: Sandbox directory to write the image into (default:
            /tmp/figma_images). The directory must be writable.
        file_name: Output file name including extension, e.g. "button.svg"
            or "hero.png" (default: export.png).

    Returns:
        Dictionary with keys:
        - success: Whether the export succeeded
        - result: Server response confirming the downloaded file path
        - error: Error message if the export failed
    """
    try:
        tool = await _get_tool("download_figma_images")
        if not tool:
            return {
                "error": "download_figma_images tool not available from figma-developer-mcp",
                "success": False,
            }

        result = await tool.ainvoke(
            {
                "fileKey": file_key,
                "nodes": [{"nodeId": node_id, "fileName": file_name}],
                "localPath": local_path,
            }
        )
        return {"success": True, "result": result}

    except Exception as e:
        return {
            "error": f"Failed to export image: {_unwrap_exception(e)}",
            "success": False,
        }


async def close_figma_client() -> None:
    """No-op: stdio transport uses ephemeral per-call processes; nothing to close."""
    pass
