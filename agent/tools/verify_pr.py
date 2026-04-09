"""PR verification tool - runs repo-aware checks in an isolated sandbox."""

from __future__ import annotations

import asyncio
import json as _json
import logging
import os
import re
import shlex
from typing import Any

from langgraph.config import get_config

from ..integrations.opensandbox import create_opensandbox_sandbox
from ..utils.github_app import get_github_app_installation_token
from ..utils.github_comments import post_github_comment
from ..utils.model import make_model

logger = logging.getLogger(__name__)

DEFAULT_VERIFICATION_COMMANDS = [
    ["make", "test"],
    ["make", "lint"],
]

DEFAULT_VERIFICATION_TIMEOUT = int(os.environ.get("PR_VERIFY_TIMEOUT", "600"))
DEFAULT_VERIFY_MODEL = os.environ.get("PR_VERIFY_MODEL") or os.environ.get(
    "DEEPAGENTS_MODEL", "anthropic:claude-opus-4-6"
)
MAX_COMMANDS_PER_PHASE = 4
MAX_FILE_READ_BYTES = 20_000
_UNSAFE_TOKEN_RE = re.compile(r"[;&|`$()<>]")
_PACKAGE_MANAGER_TO_INSTALL = {
    "pnpm": ["pnpm", "install", "--frozen-lockfile"],
    "npm": ["npm", "ci"],
    "yarn": ["yarn", "install", "--frozen-lockfile"],
    "bun": ["bun", "install", "--frozen-lockfile"],
}


async def _fetch_pr_details(
    repo_owner: str,
    repo_name: str,
    pr_number: int,
    token: str,
) -> dict[str, Any] | None:
    """Fetch PR details from GitHub API."""
    import httpx

    url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/pulls/{pr_number}"
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            if response.status_code == 200:
                return response.json()
            logger.error("Failed to fetch PR #%s: %s", pr_number, response.status_code)
        except Exception:
            logger.exception("Error fetching PR #%s", pr_number)
    return None


async def _add_pr_label(
    repo_owner: str,
    repo_name: str,
    pr_number: int,
    label: str,
    token: str,
) -> bool:
    """Add a label to a PR."""
    import httpx

    url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/issues/{pr_number}/labels"
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json={"labels": [label]},
            )
            return response.status_code in (200, 201)
        except Exception:
            logger.exception("Failed to add label %s to PR #%s", label, pr_number)
    return False


async def _remove_pr_label(
    repo_owner: str,
    repo_name: str,
    pr_number: int,
    label: str,
    token: str,
) -> bool:
    """Remove a label from a PR."""
    import httpx

    url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/issues/{pr_number}/labels/{label}"
    async with httpx.AsyncClient() as client:
        try:
            response = await client.delete(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            return response.status_code in (200, 204)
        except Exception:
            logger.exception("Failed to remove label %s from PR #%s", label, pr_number)
    return False


def _shell_join(cmd: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in cmd)


def _safe_read_file(sandbox: Any, repo_dir: str, rel_path: str) -> str:
    safe_repo_dir = shlex.quote(repo_dir)
    safe_rel_path = shlex.quote(rel_path)
    result = sandbox.execute(
        f"cd {safe_repo_dir} && if [ -f {safe_rel_path} ]; then head -c {MAX_FILE_READ_BYTES} "
        f"{safe_rel_path}; fi"
    )
    return result.output if result.exit_code == 0 and result.output else ""


def _file_exists(sandbox: Any, repo_dir: str, rel_path: str) -> bool:
    safe_repo_dir = shlex.quote(repo_dir)
    safe_rel_path = shlex.quote(rel_path)
    result = sandbox.execute(f"cd {safe_repo_dir} && test -f {safe_rel_path}")
    return result.exit_code == 0


def _list_workflows(sandbox: Any, repo_dir: str) -> list[str]:
    safe_repo_dir = shlex.quote(repo_dir)
    result = sandbox.execute(
        f"cd {safe_repo_dir} && "
        "if [ -d .github/workflows ]; then find .github/workflows -maxdepth 1 -type f | sort; fi"
    )
    if result.exit_code != 0 or not result.output:
        return []
    return [line.strip() for line in result.output.splitlines() if line.strip()]


def _detect_package_manager(files: dict[str, bool]) -> str | None:
    if files.get("pnpm-lock.yaml"):
        return "pnpm"
    if files.get("package-lock.json"):
        return "npm"
    if files.get("yarn.lock"):
        return "yarn"
    if files.get("bun.lockb") or files.get("bun.lock"):
        return "bun"
    return None


def _scan_repo(sandbox: Any, repo_dir: str) -> dict[str, Any]:
    tracked_files = [
        "Makefile",
        "package.json",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        "pyproject.toml",
        "go.mod",
        "Cargo.toml",
    ]
    files = {name: _file_exists(sandbox, repo_dir, name) for name in tracked_files}
    package_json_raw = _safe_read_file(sandbox, repo_dir, "package.json") if files["package.json"] else ""
    workflows: list[dict[str, str]] = []
    for workflow_path in _list_workflows(sandbox, repo_dir)[:5]:
        workflows.append(
            {
                "path": workflow_path,
                "content": _safe_read_file(sandbox, repo_dir, workflow_path),
            }
        )

    package_json: dict[str, Any] = {}
    if package_json_raw:
        try:
            package_json = _json.loads(package_json_raw)
        except _json.JSONDecodeError:
            logger.warning("Unable to parse package.json during verification scan")

    return {
        "files": files,
        "package_manager": _detect_package_manager(files),
        "package_json": {
            "name": package_json.get("name"),
            "packageManager": package_json.get("packageManager"),
            "scripts": package_json.get("scripts", {}),
        },
        "workflows": workflows,
    }


def _extract_json_object(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if not text:
        return None
    try:
        parsed = _json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except _json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        parsed = _json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except _json.JSONDecodeError:
        return None


def _normalize_command_list(commands: Any) -> list[list[str]]:
    if not isinstance(commands, list):
        return []
    normalized: list[list[str]] = []
    for cmd in commands[:MAX_COMMANDS_PER_PHASE]:
        if isinstance(cmd, list) and all(isinstance(part, str) and part for part in cmd):
            normalized.append(cmd)
    return normalized


def _commands_are_safe(commands: list[list[str]]) -> bool:
    for cmd in commands:
        for token in cmd:
            if _UNSAFE_TOKEN_RE.search(token):
                return False
    return True


def _build_heuristic_plan(scan: dict[str, Any]) -> dict[str, Any]:
    files = scan["files"]
    if files.get("Makefile"):
        return {
            "repo_type": "make",
            "setup_commands": [],
            "verification_commands": DEFAULT_VERIFICATION_COMMANDS,
            "reasoning": "Repo has a Makefile, so use make-based verification targets.",
            "planner": "heuristic",
        }

    scripts = scan["package_json"].get("scripts", {})
    package_manager = scan.get("package_manager")
    if scripts and package_manager:
        verification_commands: list[list[str]] = []
        for script_name in ("test", "lint", "typecheck", "build"):
            if script_name in scripts:
                verification_commands.append([package_manager, script_name])
        if verification_commands:
            setup_command = _PACKAGE_MANAGER_TO_INSTALL.get(package_manager)
            return {
                "repo_type": "javascript",
                "setup_commands": [setup_command] if setup_command else [],
                "verification_commands": verification_commands[:MAX_COMMANDS_PER_PHASE],
                "reasoning": (
                    "Repo has package.json scripts and a detected package manager, so use the "
                    "repo's own install and verification scripts."
                ),
                "planner": "heuristic",
            }

    return {
        "repo_type": "unknown",
        "setup_commands": [],
        "verification_commands": [],
        "reasoning": "Could not detect safe repo-native verification commands.",
        "planner": "heuristic",
    }


def _plan_commands_with_model(scan: dict[str, Any]) -> dict[str, Any] | None:
    scripts = scan["package_json"].get("scripts", {})
    if not any(
        (
            scan["files"].get("Makefile"),
            scan["files"].get("package.json"),
            scan["files"].get("pyproject.toml"),
            scan["files"].get("go.mod"),
        )
    ):
        return None

    prompt = (
        "You are planning CI verification commands for a checked-out repository.\n"
        "Return JSON only with keys: repo_type, setup_commands, verification_commands, reasoning.\n"
        "Each command must be an array of argv strings.\n"
        "Rules:\n"
        "- Use repo-native commands only.\n"
        "- Prefer Makefile targets if the repo is make-based.\n"
        "- For JS/TS repos, prefer the detected package manager and only scripts that exist.\n"
        "- Do not invent commands not supported by the repo.\n"
        "- If no safe plan exists, return empty command arrays and explain why.\n"
        f"Repository scan:\n{_json.dumps(scan, indent=2, sort_keys=True)}\n"
        f"Known scripts: {sorted(scripts)}"
    )

    try:
        model = make_model(DEFAULT_VERIFY_MODEL, temperature=0, max_tokens=1_500)
        response = model.invoke(prompt)
        content = response.content if hasattr(response, "content") else response
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part) for part in content
            )
        if not isinstance(content, str):
            content = str(content)
        plan = _extract_json_object(content)
        if plan is not None:
            plan["planner"] = "model"
        return plan
    except Exception:
        logger.exception("Model-based verification planning failed")
        return None


def _resolve_verification_plan(
    scan: dict[str, Any], explicit_commands: list[list[str]] | None
) -> dict[str, Any]:
    if explicit_commands:
        return {
            "repo_type": "explicit",
            "setup_commands": [],
            "verification_commands": explicit_commands,
            "reasoning": "Using explicit verification commands.",
            "planner": "explicit",
        }

    env_commands = os.environ.get("PR_VERIFY_COMMANDS")
    if env_commands:
        try:
            parsed = _json.loads(env_commands)
            commands = _normalize_command_list(parsed)
            if commands:
                return {
                    "repo_type": "env",
                    "setup_commands": [],
                    "verification_commands": commands,
                    "reasoning": "Using PR_VERIFY_COMMANDS override.",
                    "planner": "env",
                }
        except _json.JSONDecodeError:
            logger.warning("Invalid PR_VERIFY_COMMANDS JSON, ignoring override")

    model_plan = _plan_commands_with_model(scan)
    if model_plan:
        model_plan["setup_commands"] = _normalize_command_list(model_plan.get("setup_commands"))
        model_plan["verification_commands"] = _normalize_command_list(
            model_plan.get("verification_commands")
        )
        if _commands_are_safe(
            model_plan["setup_commands"] + model_plan["verification_commands"]
        ):
            return model_plan

    heuristic_plan = _build_heuristic_plan(scan)
    heuristic_plan["setup_commands"] = _normalize_command_list(heuristic_plan.get("setup_commands"))
    heuristic_plan["verification_commands"] = _normalize_command_list(
        heuristic_plan.get("verification_commands")
    )
    return heuristic_plan


def _run_command(
    sandbox: Any,
    repo_dir: str,
    cmd: list[str],
    timeout: int,
    phase: str,
) -> dict[str, Any]:
    cmd_str = _shell_join(cmd)
    result = sandbox.execute(f"cd {shlex.quote(repo_dir)} && {cmd_str}", timeout=timeout)
    return {
        "phase": phase,
        "command": cmd_str,
        "exit_code": result.exit_code,
        "output": result.output[:5000] if result.output else "",
        "truncated": len(result.output) > 5000 if result.output else False,
    }


def _setup_fallback_commands(
    cmd: list[str],
    result: dict[str, Any],
    scan: dict[str, Any],
) -> list[list[str]]:
    if (
        cmd == ["npm", "ci"]
        and scan.get("package_manager") == "npm"
        and result["exit_code"] != 0
        and "ERESOLVE" in (result.get("output") or "")
    ):
        return [
            ["npm", "install", "--legacy-peer-deps"],
            ["npm", "install"],
        ]
    return []


def _build_comment(
    *,
    pr_number: int,
    head_branch: str,
    timeout: int,
    status: str,
    reason: str | None,
    results: list[dict[str, Any]],
    planned_commands: dict[str, list[list[str]]],
) -> str:
    emoji = {"passed": "✅", "failed": "❌", "blocked": "⛔"}.get(status, "❌")
    text = {"passed": "PASSED", "failed": "FAILED", "blocked": "BLOCKED"}.get(status, "FAILED")
    comment_lines = [
        f"## {emoji} PR Verification {text}",
        "",
        f"**PR:** #{pr_number}",
        f"**Branch:** `{head_branch}`",
        f"**Verification Time:** {timeout}s timeout",
        "",
    ]

    if reason:
        comment_lines.extend([f"**Reason:** {reason}", ""])

    if planned_commands["setup"]:
        comment_lines.append("### Planned Setup")
        for cmd in planned_commands["setup"]:
            comment_lines.append(f"- `{_shell_join(cmd)}`")
        comment_lines.append("")

    if planned_commands["verify"]:
        comment_lines.append("### Planned Verification")
        for cmd in planned_commands["verify"]:
            comment_lines.append(f"- `{_shell_join(cmd)}`")
        comment_lines.append("")

    comment_lines.append("### Results:")
    if not results:
        comment_lines.append("- No commands were executed.")

    for item in results:
        prefix = "✅" if item["exit_code"] == 0 else "❌"
        phase_label = "setup" if item["phase"] == "setup" else "verify"
        comment_lines.append(f"- {prefix} **`{item['command']}`** ({phase_label})")
        if item.get("output"):
            preview = item["output"][:500]
            comment_lines.append("  ```")
            comment_lines.append(f"  {preview}")
            comment_lines.append("  ```")

    comment_lines.extend(["", "_Verified by Open SWE_"])
    return "\n".join(comment_lines)


def verify_pr(
    pr_number: int,
    commands: list[list[str]] | None = None,
    timeout: int = DEFAULT_VERIFICATION_TIMEOUT,
    add_labels: bool = True,
    repo_config: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Verify a Pull Request by running repo-aware checks in an isolated sandbox."""
    try:
        if repo_config is None:
            config = get_config()
            configurable = config.get("configurable", {})
            repo_config = configurable.get("repo", {})

        repo_owner = repo_config.get("owner")
        repo_name = repo_config.get("name")

        if not repo_owner or not repo_name:
            return {
                "success": False,
                "status": "blocked",
                "error": "Missing repo owner/name in config",
                "pr_number": pr_number,
                "results": [],
                "comment_posted": False,
                "labels_added": [],
                "planned_commands": {"setup": [], "verify": []},
            }

        token = asyncio.run(get_github_app_installation_token())
        if not token:
            return {
                "success": False,
                "status": "blocked",
                "error": "Failed to get GitHub App installation token",
                "pr_number": pr_number,
                "results": [],
                "comment_posted": False,
                "labels_added": [],
                "planned_commands": {"setup": [], "verify": []},
            }

        pr_details = asyncio.run(_fetch_pr_details(repo_owner, repo_name, pr_number, token))
        if not pr_details:
            return {
                "success": False,
                "status": "blocked",
                "error": f"Could not fetch PR #{pr_number} details",
                "pr_number": pr_number,
                "results": [],
                "comment_posted": False,
                "labels_added": [],
                "planned_commands": {"setup": [], "verify": []},
            }

        head_branch = pr_details.get("head", {}).get("ref")
        head_repo = pr_details.get("head", {}).get("repo", {}).get("clone_url")

        if not head_branch or not head_repo:
            return {
                "success": False,
                "status": "blocked",
                "error": "Could not determine PR branch or repository",
                "pr_number": pr_number,
                "results": [],
                "comment_posted": False,
                "labels_added": [],
                "planned_commands": {"setup": [], "verify": []},
            }

        sandbox = create_opensandbox_sandbox(timeout=timeout)

        try:
            cred_file = "/tmp/.git-credentials"
            sandbox.write(cred_file, f"https://git:{token}@github.com\n")
            sandbox.execute(f"chmod 600 {cred_file}")

            work_dir = "/home/user"
            repo_dir = f"{work_dir}/{repo_name}"
            safe_repo_dir = shlex.quote(repo_dir)
            safe_repo_url = shlex.quote(head_repo)
            cred_helper = shlex.quote(f"store --file={cred_file}")

            clone_result = sandbox.execute(
                f"git -c credential.helper={cred_helper} clone {safe_repo_url} {safe_repo_dir}"
            )
            if clone_result.exit_code != 0:
                return {
                    "success": False,
                    "status": "blocked",
                    "error": f"Failed to clone repository: {clone_result.output}",
                    "pr_number": pr_number,
                    "results": [],
                    "comment_posted": False,
                    "labels_added": [],
                    "planned_commands": {"setup": [], "verify": []},
                }

            checkout_result = sandbox.execute(
                f"cd {safe_repo_dir} && "
                f"git config credential.helper {cred_helper} && "
                "git fetch origin && "
                f"git checkout {shlex.quote(head_branch)}"
            )
            if checkout_result.exit_code != 0:
                return {
                    "success": False,
                    "status": "blocked",
                    "error": f"Failed to checkout branch {head_branch}: {checkout_result.output}",
                    "pr_number": pr_number,
                    "results": [],
                    "comment_posted": False,
                    "labels_added": [],
                    "planned_commands": {"setup": [], "verify": []},
                }

            scan = _scan_repo(sandbox, repo_dir)
            plan = _resolve_verification_plan(scan, commands)
            setup_commands = plan.get("setup_commands", [])
            verification_commands = plan.get("verification_commands", [])
            planned_commands = {"setup": setup_commands, "verify": verification_commands}
            results: list[dict[str, Any]] = []
            status = "passed"
            error = None

            if not verification_commands:
                status = "blocked"
                error = plan.get("reasoning") or "No safe verification commands were found"
            elif not _commands_are_safe(setup_commands + verification_commands):
                status = "blocked"
                error = "Verification planner returned unsafe commands"
            else:
                for cmd in setup_commands:
                    result = _run_command(sandbox, repo_dir, cmd, timeout, "setup")
                    results.append(result)
                    if result["exit_code"] != 0:
                        fallback_succeeded = False
                        for fallback_cmd in _setup_fallback_commands(cmd, result, scan):
                            fallback_result = _run_command(
                                sandbox, repo_dir, fallback_cmd, timeout, "setup"
                            )
                            results.append(fallback_result)
                            if fallback_result["exit_code"] == 0:
                                fallback_succeeded = True
                                break
                        if fallback_succeeded:
                            continue
                        status = "failed"
                        error = f"Setup failed: {_shell_join(cmd)}"
                        break

                if status == "passed":
                    for cmd in verification_commands:
                        result = _run_command(sandbox, repo_dir, cmd, timeout, "verify")
                        results.append(result)
                        if result["exit_code"] != 0:
                            status = "failed"
                            error = f"Verification failed: {_shell_join(cmd)}"
                            break

            comment_body = _build_comment(
                pr_number=pr_number,
                head_branch=head_branch,
                timeout=timeout,
                status=status,
                reason=error or plan.get("reasoning"),
                results=results,
                planned_commands=planned_commands,
            )
            comment_posted = asyncio.run(
                post_github_comment(repo_config, pr_number, comment_body, token=token)
            )

            labels_added: list[str] = []
            if add_labels:
                if status == "passed":
                    asyncio.run(
                        _remove_pr_label(
                            repo_owner, repo_name, pr_number, "verification-failed", token
                        )
                    )
                    if asyncio.run(_add_pr_label(repo_owner, repo_name, pr_number, "verified", token)):
                        labels_added.append("verified")
                else:
                    asyncio.run(_remove_pr_label(repo_owner, repo_name, pr_number, "verified", token))
                    if asyncio.run(
                        _add_pr_label(repo_owner, repo_name, pr_number, "verification-failed", token)
                    ):
                        labels_added.append("verification-failed")

            return {
                "success": status == "passed",
                "status": status,
                "pr_number": pr_number,
                "results": results,
                "comment_posted": comment_posted,
                "labels_added": labels_added,
                "error": error,
                "planned_commands": planned_commands,
                "planner": plan.get("planner"),
                "repo_type": plan.get("repo_type"),
            }
        finally:
            try:
                sandbox.execute(f"rm -f {cred_file}")
            except Exception:
                pass

    except Exception as e:
        logger.exception("verify_pr failed")
        return {
            "success": False,
            "status": "blocked",
            "error": f"{type(e).__name__}: {e}",
            "pr_number": pr_number,
            "results": [],
            "comment_posted": False,
            "labels_added": [],
            "planned_commands": {"setup": [], "verify": []},
        }
