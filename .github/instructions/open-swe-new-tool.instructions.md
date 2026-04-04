---
description: "Use when adding a new tool to the Open SWE agent. Covers the @tool decorator pattern, file structure in agent/tools/, registration in __init__.py and server.py."
---

# Adding a New Agent Tool

## 1. Create the Tool File

Create `agent/tools/<tool_name>.py`. Each tool lives in its own file.

Use the LangChain `@tool` decorator (for simple tools) or a regular function (for tools already callable as-is):

```python
# agent/tools/my_tool.py
from typing import Any

from langchain_core.tools import tool


@tool
def my_tool(param: str, optional_param: int = 10) -> dict[str, Any]:
    """Short one-line summary used as the tool description in the LLM.

    More detail the agent will see when deciding whether to call this tool.

    Args:
        param: Description of this required parameter.
        optional_param: Description with default.

    Returns:
        Dictionary with result keys.
    """
    # implementation
    return {"result": param}
```

**Docstring rules:**

- First line → tool description shown to the LLM. Make it specific and action-oriented.
- Args section → shown to the LLM as parameter descriptions. Include them.
- Never omit type hints on parameters.

## 2. Export from `agent/tools/__init__.py`

Add the import and add the name to `__all__`:

```python
from .my_tool import my_tool

__all__ = [
    ...,
    "my_tool",
]
```

Keep the list alphabetically sorted.

## 3. Register in `agent/server.py`

Import at the top with the other tool imports:

```python
from .tools import (
    ...,
    my_tool,
)
```

Add to the `tools=[...]` list inside `get_agent()`:

```python
tools=[
    ...,
    my_tool,
],
```

## Checklist

- [ ] Single file in `agent/tools/<tool_name>.py`
- [ ] `@tool` decorator from `langchain_core.tools`
- [ ] Descriptive first-line docstring (the LLM sees this)
- [ ] All parameters have type hints
- [ ] Exported in `agent/tools/__init__.py`
- [ ] Added to `tools=[...]` in `agent/server.py`
- [ ] No sandbox calls in unit tests — mock the sandbox client
