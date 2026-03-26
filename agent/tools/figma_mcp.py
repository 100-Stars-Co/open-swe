"""Figma MCP tools for accessing Figma design files.

This module provides tools to interact with Figma design files via the
Model Context Protocol (MCP). The Figma MCP server runs as a subprocess
and provides tools for extracting layout and styling information.
"""

from typing import Any

from langchain_mcp_adapters.client import MultiServerMCPClient

# Global client instance for caching
_figma_client: MultiServerMCPClient | None = None


async def _get_figma_client() -> MultiServerMCPClient:
    """Get or create the Figma MCP client.

    Returns:
        Configured MultiServerMCPClient instance for Figma
    """
    global _figma_client

    if _figma_client is not None:
        return _figma_client

    import os

    figma_api_key = os.environ.get("FIGMA_API_KEY")

    # Initialize the MCP client with Figma server configuration
    _figma_client = MultiServerMCPClient(
        {
            "figma": {
                "command": "npx",
                "args": ["-y", "figma-developer-mcp", "--stdio"],
                "env": {"FIGMA_API_KEY": figma_api_key} if figma_api_key else {},
            }
        }
    )

    await _figma_client.__aenter__()
    return _figma_client


async def figma_get_file(
    file_key: str,
    node_id: str | None = None,
    depth: int | None = None,
) -> dict[str, Any]:
    """Get a Figma file's layout and styling information.

    This tool retrieves design information from a Figma file, including
    layout structure, colors, typography, and component details. The response
    is simplified to provide only the most relevant information for implementation.

    Args:
        file_key: The Figma file key (from the URL, e.g., "ABC123" in
            figma.com/file/ABC123/file-name)
        node_id: Optional specific node ID to fetch (for targeting a specific
            component or frame)
        depth: Optional depth level for fetching nested elements (use to limit
            response size for large files)

    Returns:
        Dictionary containing:
        - success: Whether the request succeeded
        - document: The file's document structure with layout and styling info
        - error: Error message if the request failed

    Example:
        file_key = "ABC123xyz"  # From figma.com/file/ABC123xyz/my-design
        result = figma_get_file(file_key)
    """
    try:
        client = await _get_figma_client()
        tools = await client.get_tools()

        # Find the get_file tool
        get_file_tool = None
        for tool in tools:
            if hasattr(tool, "name") and tool.name == "get_file":
                get_file_tool = tool
                break

        if not get_file_tool:
            return {"error": "Figma get_file tool not available"}

        # Build arguments
        args: dict[str, Any] = {"fileKey": file_key}
        if node_id:
            args["nodeId"] = node_id
        if depth is not None:
            args["depth"] = depth

        # Invoke the tool
        result = await get_file_tool.ainvoke(args)
        return {"success": True, "document": result}

    except Exception as e:
        return {"error": f"Failed to get Figma file: {e!s}", "success": False}


async def figma_get_component(
    file_key: str,
    component_id: str,
) -> dict[str, Any]:
    """Get detailed information about a specific Figma component.

    This tool retrieves component-specific information including its
    properties, variants, and styling details.

    Args:
        file_key: The Figma file key containing the component
        component_id: The unique identifier of the component

    Returns:
        Dictionary containing:
        - success: Whether the request succeeded
        - component: Component details including properties and styles
        - error: Error message if the request failed
    """
    try:
        client = await _get_figma_client()
        tools = await client.get_tools()

        # Find the get_component tool
        get_component_tool = None
        for tool in tools:
            if hasattr(tool, "name") and tool.name == "get_component":
                get_component_tool = tool
                break

        if not get_component_tool:
            return {"error": "Figma get_component tool not available"}

        result = await get_component_tool.ainvoke(
            {"fileKey": file_key, "componentId": component_id}
        )
        return {"success": True, "component": result}

    except Exception as e:
        return {"error": f"Failed to get Figma component: {e!s}", "success": False}


async def figma_export_image(
    file_key: str,
    node_id: str,
    format: str = "png",
    scale: float = 1.0,
) -> dict[str, Any]:
    """Export an image from a Figma file.

    This tool exports a specific node (frame, component, or layer) as an image.

    Args:
        file_key: The Figma file key
        node_id: The specific node ID to export
        format: Image format (png, svg, pdf, jpg) - default: png
        scale: Export scale factor - default: 1.0 (use 2.0 for retina)

    Returns:
        Dictionary containing:
        - success: Whether the export succeeded
        - url: Temporary URL to the exported image
        - error: Error message if the export failed
    """
    try:
        client = await _get_figma_client()
        tools = await client.get_tools()

        # Find the export_image tool
        export_tool = None
        for tool in tools:
            if hasattr(tool, "name") and tool.name == "export_image":
                export_tool = tool
                break

        if not export_tool:
            return {"error": "Figma export_image tool not available"}

        result = await export_tool.ainvoke(
            {
                "fileKey": file_key,
                "nodeId": node_id,
                "format": format,
                "scale": scale,
            }
        )
        return {"success": True, "url": result}

    except Exception as e:
        return {"error": f"Failed to export image: {e!s}", "success": False}


async def close_figma_client() -> None:
    """Close the Figma MCP client connection.

    This should be called when done using Figma tools to clean up resources.
    """
    global _figma_client

    if _figma_client is not None:
        await _figma_client.__aexit__(None, None, None)
        _figma_client = None
