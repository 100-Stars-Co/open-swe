import os

from agent.integrations.daytona import create_daytona_sandbox
from agent.integrations.e2b import create_e2b_sandbox
from agent.integrations.langsmith import create_langsmith_sandbox
from agent.integrations.local import create_local_sandbox
from agent.integrations.modal import create_modal_sandbox
from agent.integrations.runloop import create_runloop_sandbox


def _create_opensandbox_sandbox_lazy(sandbox_id: str | None = None, timeout: int | None = None):
    """Lazy import for OpenSandbox to avoid ImportError when not used."""
    from agent.integrations.opensandbox import create_opensandbox_sandbox

    return create_opensandbox_sandbox(sandbox_id, timeout=timeout)


SANDBOX_FACTORIES = {
    "langsmith": create_langsmith_sandbox,
    "daytona": create_daytona_sandbox,
    "modal": create_modal_sandbox,
    "runloop": create_runloop_sandbox,
    "local": create_local_sandbox,
    "e2b": create_e2b_sandbox,
    "opensandbox": _create_opensandbox_sandbox_lazy,
}


def create_sandbox(sandbox_id: str | None = None, timeout: int | None = None):
    """Create or reconnect to a sandbox using the configured provider.

    The provider is selected via the SANDBOX_TYPE environment variable.
    Supported values: langsmith (default), daytona, modal, runloop, local, e2b, opensandbox.

    Args:
        sandbox_id: Optional existing sandbox ID to reconnect to.
        timeout: Optional timeout for the sandbox lease in seconds.

    Returns:
        A sandbox backend implementing SandboxBackendProtocol.
    """
    sandbox_type = os.getenv("SANDBOX_TYPE", "langsmith")
    factory = SANDBOX_FACTORIES.get(sandbox_type)
    if not factory:
        supported = ", ".join(sorted(SANDBOX_FACTORIES))
        raise ValueError(f"Invalid sandbox type: {sandbox_type}. Supported types: {supported}")

    # Pass timeout only if the factory supports it
    # For now, only E2B and OpenSandbox are updated to support it explicitly in their signature
    if sandbox_type in ("e2b", "opensandbox"):
        return factory(sandbox_id, timeout=timeout)
    return factory(sandbox_id)
