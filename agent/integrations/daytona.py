import logging
import os

from daytona import CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig
from langchain_daytona import DaytonaSandbox

logger = logging.getLogger(__name__)

# TODO: Update this to include your specific sandbox configuration
DAYTONA_SANDBOX_PARAMS = CreateSandboxFromSnapshotParams(
    snapshot="daytonaio/sandbox:0.6.0"
)


def create_daytona_sandbox(sandbox_id: str | None = None):
    api_key = os.getenv("DAYTONA_API_KEY")
    if not api_key:
        raise ValueError("DAYTONA_API_KEY environment variable is required")

    api_url = os.getenv("DAYTONA_API_URL", "https://app.daytona.io/api")

    daytona = Daytona(
        config=DaytonaConfig(api_url=api_url, api_key=api_key)
    )

    if sandbox_id:
        sandbox = daytona.get(sandbox_id)
    else:
        sandbox = daytona.create(params=DAYTONA_SANDBOX_PARAMS)

    return DaytonaSandbox(sandbox=sandbox)


def delete_daytona_sandbox(sandbox_id: str) -> bool:
    """Delete a Daytona sandbox by ID.

    Args:
        sandbox_id: The ID of the sandbox to delete.

    Returns:
        True if deletion was successful or sandbox didn't exist, False otherwise.
    """
    api_key = os.getenv("DAYTONA_API_KEY")
    if not api_key:
        logger.warning("DAYTONA_API_KEY not set, cannot delete sandbox %s", sandbox_id)
        return False

    try:
        api_url = os.getenv("DAYTONA_API_URL", "https://app.daytona.io/api")
        daytona = Daytona(config=DaytonaConfig(api_url=api_url, api_key=api_key))
        sandbox = daytona.get(sandbox_id)
        daytona.delete(sandbox)
        logger.info("Successfully deleted Daytona sandbox %s", sandbox_id)
        return True
    except RuntimeError as e:
        # Sandbox not found or other runtime error
        if "not found" in str(e).lower():
            logger.info("Daytona sandbox %s already deleted or not found", sandbox_id)
            return True
        logger.exception("Failed to delete Daytona sandbox %s", sandbox_id)
        return False
    except Exception:
        logger.exception("Failed to delete Daytona sandbox %s", sandbox_id)
        return False
