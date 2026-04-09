"""Tests for PR verification tool and middleware."""

from __future__ import annotations

import json as _json
import os
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from agent.middleware.verify_pr import (
    _extract_pr_number_from_messages,
    _verify_pr_after_agent_impl,
)
from agent.tools.verify_pr import (
    DEFAULT_VERIFICATION_COMMANDS,
    DEFAULT_VERIFICATION_TIMEOUT,
    verify_pr,
)


class TestExtractPrNumberFromMessages:
    """Tests for _extract_pr_number_from_messages helper."""

    def test_extracts_pr_number_from_successful_commit_and_open_pr(self) -> None:
        """Test extracting PR number from a successful commit_and_open_pr result."""
        messages = [
            HumanMessage(content="fix the bug"),
            AIMessage(content="I'll create a PR"),
            ToolMessage(
                content=_json.dumps(
                    {
                        "success": True,
                        "pr_url": "https://github.com/owner/repo/pull/123",
                        "error": None,
                    }
                ),
                tool_call_id="abc123",
                name="commit_and_open_pr",
            ),
        ]

        result = _extract_pr_number_from_messages(messages)
        assert result == 123

    def test_extracts_from_latest_pr_creation(self) -> None:
        """Test extracting from the latest PR creation when multiple exist."""
        messages = [
            ToolMessage(
                content=_json.dumps(
                    {
                        "success": True,
                        "pr_url": "https://github.com/owner/repo/pull/100",
                        "error": None,
                    }
                ),
                tool_call_id="1",
                name="commit_and_open_pr",
            ),
            ToolMessage(
                content=_json.dumps(
                    {
                        "success": True,
                        "pr_url": "https://github.com/owner/repo/pull/200",
                        "error": None,
                    }
                ),
                tool_call_id="2",
                name="commit_and_open_pr",
            ),
        ]

        result = _extract_pr_number_from_messages(messages)
        assert result == 200

    def test_returns_none_when_pr_creation_failed(self) -> None:
        """Test returning None when commit_and_open_pr failed."""
        messages = [
            ToolMessage(
                content=_json.dumps(
                    {
                        "success": False,
                        "pr_url": None,
                        "error": "Something went wrong",
                    }
                ),
                tool_call_id="abc123",
                name="commit_and_open_pr",
            ),
        ]

        result = _extract_pr_number_from_messages(messages)
        assert result is None

    def test_returns_none_when_no_commit_and_open_pr(self) -> None:
        """Test returning None when no commit_and_open_pr tool was called."""
        messages = [
            HumanMessage(content="hello"),
            AIMessage(content="hi"),
            ToolMessage(content="result", tool_call_id="123", name="bash"),
        ]

        result = _extract_pr_number_from_messages(messages)
        assert result is None

    def test_returns_none_for_empty_messages(self) -> None:
        """Test returning None for empty message list."""
        result = _extract_pr_number_from_messages([])
        assert result is None

    def test_handles_invalid_json_content(self) -> None:
        """Test handling invalid JSON in tool message content."""
        messages = [
            ToolMessage(
                content="not valid json",
                tool_call_id="abc123",
                name="commit_and_open_pr",
            ),
        ]

        result = _extract_pr_number_from_messages(messages)
        assert result is None

    def test_handles_missing_pr_url(self) -> None:
        """Test handling missing pr_url in result."""
        messages = [
            ToolMessage(
                content=_json.dumps(
                    {
                        "success": True,
                        "error": None,
                    }
                ),
                tool_call_id="abc123",
                name="commit_and_open_pr",
            ),
        ]

        result = _extract_pr_number_from_messages(messages)
        assert result is None


class TestVerifyPrDefaults:
    """Tests for default constants in verify_pr module."""

    def test_default_verification_commands(self) -> None:
        """Test default verification commands constant."""
        assert DEFAULT_VERIFICATION_COMMANDS == [["make", "test"], ["make", "lint"]]

    def test_default_timeout_constant(self) -> None:
        """Test default timeout constant."""
        assert DEFAULT_VERIFICATION_TIMEOUT == 600


class TestVerifyPrTool:
    """Tests for the verify_pr tool."""

    @pytest.fixture
    def mock_config(self) -> dict:
        """Create a mock config for testing."""
        return {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {
                    "owner": "testowner",
                    "name": "testrepo",
                },
            },
        }

    @pytest.fixture
    def mock_pr_details(self) -> dict:
        """Create mock PR details from GitHub API."""
        return {
            "number": 123,
            "head": {
                "ref": "feature/test-branch",
                "repo": {
                    "clone_url": "https://github.com/testowner/testrepo.git",
                },
            },
        }

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    def test_missing_repo_config(self, mock_get_token, mock_get_config) -> None:
        """Test verify_pr fails when repo config is missing."""
        mock_get_config.return_value = {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {},  # Missing owner/name
            },
        }

        result = verify_pr(pr_number=123)

        assert result["success"] is False
        assert "Missing repo owner/name" in result["error"]
        assert result["pr_number"] == 123
        assert result["comment_posted"] is False
        mock_get_token.assert_not_called()

    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    def test_verify_pr_with_explicit_repo_config(self, mock_fetch_pr, mock_get_token) -> None:
        """Test verify_pr works with explicitly provided repo_config parameter."""
        # When repo_config is provided, get_config should not be called
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {
                "ref": "feature/test",
                "repo": {"clone_url": "https://github.com/explicitowner/explicitrepo.git"},
            },
        }

        # Provide repo_config explicitly - should not need get_config
        explicit_repo_config = {"owner": "explicitowner", "name": "explicitrepo"}

        with patch("agent.tools.verify_pr.create_sandbox") as mock_create_sandbox:
            mock_sandbox = MagicMock()
            mock_create_sandbox.return_value = mock_sandbox

            def execute_side_effect(cmd, **kwargs):
                result = MagicMock()
                result.exit_code = 0
                result.output = ""
                return result

            mock_sandbox.execute.side_effect = execute_side_effect

            with (
                patch("agent.tools.verify_pr._plan_commands_with_model", return_value=None),
                patch("agent.tools.verify_pr.post_github_comment", return_value=True),
            ):
                result = verify_pr(pr_number=123, repo_config=explicit_repo_config)

                # Verify the function used the explicit repo_config
                mock_fetch_pr.assert_called_once()
                call_args = mock_fetch_pr.call_args
                assert call_args[0][0] == "explicitowner"
                assert call_args[0][1] == "explicitrepo"
                # Verify the result
                assert result["pr_number"] == 123

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    def test_missing_github_token(self, mock_get_token, mock_get_config, mock_config) -> None:
        """Test verify_pr fails when GitHub token is unavailable."""
        mock_get_config.return_value = mock_config
        mock_get_token.return_value = None

        result = verify_pr(pr_number=123)

        assert result["success"] is False
        assert "Failed to get GitHub App installation token" in result["error"]
        assert result["pr_number"] == 123

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    def test_pr_not_found(
        self, mock_fetch_pr, mock_get_token, mock_get_config, mock_config
    ) -> None:
        """Test verify_pr fails when PR details cannot be fetched."""
        mock_get_config.return_value = mock_config
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = None

        result = verify_pr(pr_number=123)

        assert result["success"] is False
        assert "Could not fetch PR #123 details" in result["error"]

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    def test_missing_head_branch(
        self, mock_fetch_pr, mock_get_token, mock_get_config, mock_config
    ) -> None:
        """Test verify_pr fails when PR head branch is missing."""
        mock_get_config.return_value = mock_config
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {},  # Missing ref and repo
        }

        result = verify_pr(pr_number=123)

        assert result["success"] is False
        assert "Could not determine PR branch or repository" in result["error"]


class TestVerifyPrMiddleware:
    """Tests for verify_pr_after_agent middleware."""

    @pytest.fixture
    def mock_runtime(self) -> MagicMock:
        """Create a mock runtime for testing."""
        return MagicMock()

    @pytest.fixture
    def mock_state_with_pr(self) -> dict:
        """Create a mock state with successful PR creation."""
        return {
            "messages": [
                HumanMessage(content="fix the bug"),
                ToolMessage(
                    content=_json.dumps(
                        {
                            "success": True,
                            "pr_url": "https://github.com/owner/repo/pull/456",
                            "error": None,
                        }
                    ),
                    tool_call_id="abc123",
                    name="commit_and_open_pr",
                ),
            ],
        }

    @pytest.mark.asyncio
    @patch.dict(os.environ, {"OPEN_SWE_AUTO_VERIFY_PR": "true"})
    @patch("agent.middleware.verify_pr.get_config")
    @patch("agent.middleware.verify_pr.verify_pr")
    async def test_middleware_runs_when_enabled(
        self, mock_verify_pr, mock_get_config, mock_state_with_pr, mock_runtime
    ) -> None:
        """Test middleware runs verification when auto-verify is enabled."""
        mock_get_config.return_value = {
            "configurable": {"thread_id": "test-thread-123"},
        }
        mock_verify_pr.return_value = {
            "success": True,
            "pr_number": 456,
            "results": [],
            "comment_posted": True,
            "labels_added": ["verified"],
            "error": None,
        }

        result = await _verify_pr_after_agent_impl(mock_state_with_pr, mock_runtime)

        assert result is not None
        assert "auto_verification" in result
        assert result["auto_verification"]["success"] is True
        mock_verify_pr.assert_called_once_with(pr_number=456, timeout=600, add_labels=True)

    @pytest.mark.asyncio
    @patch.dict(os.environ, {}, clear=True)
    async def test_middleware_skips_when_disabled(self, mock_state_with_pr, mock_runtime) -> None:
        """Test middleware returns None when auto-verify is disabled."""
        result = await _verify_pr_after_agent_impl(mock_state_with_pr, mock_runtime)
        assert result is None

    @pytest.mark.asyncio
    @patch.dict(os.environ, {"OPEN_SWE_AUTO_VERIFY_PR": "false"})
    async def test_middleware_skips_when_explicitly_disabled(
        self, mock_state_with_pr, mock_runtime
    ) -> None:
        """Test middleware returns None when OPEN_SWE_AUTO_VERIFY_PR is false."""
        result = await _verify_pr_after_agent_impl(mock_state_with_pr, mock_runtime)
        assert result is None

    @pytest.mark.asyncio
    @patch.dict(os.environ, {"OPEN_SWE_AUTO_VERIFY_PR": "true"})
    @patch("agent.middleware.verify_pr.get_config")
    async def test_middleware_skips_without_thread_id(
        self, mock_get_config, mock_state_with_pr, mock_runtime
    ) -> None:
        """Test middleware skips when thread_id is missing."""
        mock_get_config.return_value = {
            "configurable": {},  # Missing thread_id
        }

        result = await _verify_pr_after_agent_impl(mock_state_with_pr, mock_runtime)
        assert result is None

    @pytest.mark.asyncio
    @patch.dict(os.environ, {"OPEN_SWE_AUTO_VERIFY_PR": "true"})
    @patch("agent.middleware.verify_pr.get_config")
    async def test_middleware_skips_without_pr_creation(
        self, mock_get_config, mock_runtime
    ) -> None:
        """Test middleware skips when no PR was created."""
        mock_get_config.return_value = {
            "configurable": {"thread_id": "test-thread-123"},
        }
        state = {
            "messages": [
                HumanMessage(content="do something"),
                ToolMessage(content="done", tool_call_id="123", name="bash"),
            ],
        }

        result = await _verify_pr_after_agent_impl(state, mock_runtime)
        assert result is None


class TestVerifyPrIntegrationScenarios:
    """Integration-style tests for common scenarios."""

    @pytest.fixture
    def mock_sandbox_backend(self) -> MagicMock:
        """Create a mock sandbox backend."""
        backend = MagicMock()

        # Mock successful clone
        clone_result = MagicMock()
        clone_result.exit_code = 0
        clone_result.output = ""
        backend.execute.return_value = clone_result

        return backend

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    @patch("agent.tools.verify_pr.create_sandbox")
    @patch("agent.tools.verify_pr._add_pr_label")
    @patch("agent.tools.verify_pr._remove_pr_label")
    @patch("agent.tools.verify_pr.post_github_comment")
    @patch("agent.tools.verify_pr._plan_commands_with_model", return_value=None)
    def test_successful_verification_all_pass(
        self,
        _mock_plan,
        mock_post_comment,
        mock_remove_label,
        mock_add_label,
        mock_create_sandbox,
        mock_fetch_pr,
        mock_get_token,
        mock_get_config,
        mock_sandbox_backend,
    ) -> None:
        """Test successful verification when all commands pass."""
        # Setup config
        mock_get_config.return_value = {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {"owner": "testowner", "name": "testrepo"},
            },
        }
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {
                "ref": "feature/test",
                "repo": {"clone_url": "https://github.com/testowner/testrepo.git"},
            },
        }

        # Setup sandbox with successful command execution
        mock_sandbox = mock_sandbox_backend
        mock_create_sandbox.return_value = mock_sandbox

        # Setup command results - all pass
        def execute_side_effect(cmd, **kwargs):
            result = MagicMock()
            if "test -f Makefile" in cmd:
                result.exit_code = 0
                result.output = "exists"
            elif "make test" in cmd or "make lint" in cmd:
                result.exit_code = 0
                result.output = "All tests passed!"
            else:
                result.exit_code = 0
                result.output = ""
            return result

        mock_sandbox.execute.side_effect = execute_side_effect
        mock_add_label.return_value = True
        mock_post_comment.return_value = True

        result = verify_pr(pr_number=123)

        assert result["success"] is True
        assert result["status"] == "passed"
        assert result["comment_posted"] is True
        assert "verified" in result["labels_added"]

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    @patch("agent.tools.verify_pr.create_sandbox")
    @patch("agent.tools.verify_pr._add_pr_label")
    @patch("agent.tools.verify_pr._remove_pr_label")
    @patch("agent.tools.verify_pr.post_github_comment")
    @patch("agent.tools.verify_pr._plan_commands_with_model", return_value=None)
    def test_failed_verification_one_fails(
        self,
        _mock_plan,
        mock_post_comment,
        mock_remove_label,
        mock_add_label,
        mock_create_sandbox,
        mock_fetch_pr,
        mock_get_token,
        mock_get_config,
        mock_sandbox_backend,
    ) -> None:
        """Test failed verification when one command fails."""
        # Setup config
        mock_get_config.return_value = {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {"owner": "testowner", "name": "testrepo"},
            },
        }
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {
                "ref": "feature/test",
                "repo": {"clone_url": "https://github.com/testowner/testrepo.git"},
            },
        }

        # Setup sandbox
        mock_sandbox = mock_sandbox_backend
        mock_create_sandbox.return_value = mock_sandbox

        # Setup command results - test passes, lint fails
        def execute_side_effect(cmd, **kwargs):
            result = MagicMock()
            if "test -f Makefile" in cmd:
                result.exit_code = 0
                result.output = "exists"
            elif "make test" in cmd:
                result.exit_code = 0
                result.output = "Tests passed!"
            elif "make lint" in cmd:
                result.exit_code = 1
                result.output = "Lint errors found!"
            else:
                result.exit_code = 0
                result.output = ""
            return result

        mock_sandbox.execute.side_effect = execute_side_effect
        mock_add_label.return_value = True
        mock_post_comment.return_value = True

        result = verify_pr(pr_number=123)

        assert result["success"] is False
        assert result["status"] == "failed"
        assert result["comment_posted"] is True
        assert "verification-failed" in result["labels_added"]

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    @patch("agent.tools.verify_pr.create_sandbox")
    @patch("agent.tools.verify_pr.post_github_comment")
    def test_custom_commands_from_env(
        self,
        mock_post_comment,
        mock_create_sandbox,
        mock_fetch_pr,
        mock_get_token,
        mock_get_config,
        mock_sandbox_backend,
    ) -> None:
        """Test using custom verification commands from environment variable."""
        with patch.dict(os.environ, {"PR_VERIFY_COMMANDS": '[["pytest", "-xvs"], ["mypy", "."]]'}):
            # Setup config
            mock_get_config.return_value = {
                "configurable": {
                    "thread_id": "test-thread-123",
                    "repo": {"owner": "testowner", "name": "testrepo"},
                },
            }
            mock_get_token.return_value = "fake-token"
            mock_fetch_pr.return_value = {
                "number": 123,
                "head": {
                    "ref": "feature/test",
                    "repo": {"clone_url": "https://github.com/testowner/testrepo.git"},
                },
            }

            # Setup sandbox
            mock_sandbox = mock_sandbox_backend
            mock_create_sandbox.return_value = mock_sandbox

            # Setup command results
            def execute_side_effect(cmd, **kwargs):
                result = MagicMock()
                result.exit_code = 0
                result.output = ""
                return result

            mock_sandbox.execute.side_effect = execute_side_effect
            mock_post_comment.return_value = True

            verify_pr(pr_number=123)

            # Check that custom commands were executed
            executed_commands = [call[0][0] for call in mock_sandbox.execute.call_args_list]
            assert any("pytest" in cmd for cmd in executed_commands)
            assert any("mypy" in cmd for cmd in executed_commands)


class TestVerifyPrEdgeCases:
    """Edge case tests for verify_pr."""

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    @patch("agent.tools.verify_pr.create_sandbox")
    @patch("agent.tools.verify_pr._plan_commands_with_model", return_value=None)
    def test_no_makefile_blocks_without_safe_commands(
        self, _mock_plan, mock_create_sandbox, mock_fetch_pr, mock_get_token, mock_get_config
    ) -> None:
        """Test that verification is blocked when no safe commands can be inferred."""
        mock_get_config.return_value = {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {"owner": "testowner", "name": "testrepo"},
            },
        }
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {
                "ref": "feature/test",
                "repo": {"clone_url": "https://github.com/testowner/testrepo.git"},
            },
        }

        mock_sandbox = MagicMock()
        mock_create_sandbox.return_value = mock_sandbox

        def execute_side_effect(cmd, **kwargs):
            result = MagicMock()
            if "git clone" in cmd or "git checkout" in cmd or "chmod 600" in cmd:
                result.exit_code = 0
                result.output = ""
            elif "test -f " in cmd:
                result.exit_code = 1
                result.output = ""
            else:
                result.exit_code = 0
                result.output = ""
            return result

        mock_sandbox.execute.side_effect = execute_side_effect

        with patch("agent.tools.verify_pr.post_github_comment", return_value=True):
            result = verify_pr(pr_number=123, add_labels=False)

        assert result["success"] is False
        assert result["status"] == "blocked"
        assert result["planned_commands"] == {"setup": [], "verify": []}

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    @patch("agent.tools.verify_pr.create_sandbox")
    @patch("agent.tools.verify_pr._plan_commands_with_model", return_value=None)
    def test_javascript_repo_uses_repo_scripts(
        self, _mock_plan, mock_create_sandbox, mock_fetch_pr, mock_get_token, mock_get_config
    ) -> None:
        """Test that JS/TS repos use package-manager scripts instead of make."""
        mock_get_config.return_value = {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {"owner": "testowner", "name": "testrepo"},
            },
        }
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {
                "ref": "feature/test",
                "repo": {"clone_url": "https://github.com/testowner/testrepo.git"},
            },
        }

        mock_sandbox = MagicMock()
        mock_create_sandbox.return_value = mock_sandbox

        package_json = _json.dumps(
            {
                "name": "ts-repo",
                "scripts": {
                    "test": "vitest run",
                    "lint": "eslint .",
                    "typecheck": "tsc --noEmit",
                },
            }
        )

        def execute_side_effect(cmd, **kwargs):
            result = MagicMock()
            if "git clone" in cmd or "git checkout" in cmd or "chmod 600" in cmd:
                result.exit_code = 0
                result.output = ""
            elif "test -f Makefile" in cmd:
                result.exit_code = 1
                result.output = ""
            elif "test -f package.json" in cmd or "test -f pnpm-lock.yaml" in cmd:
                result.exit_code = 0
                result.output = ""
            elif "test -f " in cmd:
                result.exit_code = 1
                result.output = ""
            elif "head -c" in cmd and "package.json" in cmd:
                result.exit_code = 0
                result.output = package_json
            elif "pnpm install --frozen-lockfile" in cmd:
                result.exit_code = 0
                result.output = "installed"
            elif "pnpm test" in cmd or "pnpm lint" in cmd or "pnpm typecheck" in cmd:
                result.exit_code = 0
                result.output = "ok"
            else:
                result.exit_code = 0
                result.output = ""
            return result

        mock_sandbox.execute.side_effect = execute_side_effect

        with patch("agent.tools.verify_pr.post_github_comment", return_value=True):
            result = verify_pr(pr_number=123, add_labels=False)

        executed_commands = [call.args[0] for call in mock_sandbox.execute.call_args_list]
        assert result["success"] is True
        assert result["status"] == "passed"
        assert result["planned_commands"]["setup"] == [["pnpm", "install", "--frozen-lockfile"]]
        assert result["planned_commands"]["verify"] == [
            ["pnpm", "test"],
            ["pnpm", "lint"],
            ["pnpm", "typecheck"],
        ]
        assert not any("make test" in cmd or "make lint" in cmd for cmd in executed_commands)

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    @patch("agent.tools.verify_pr.create_sandbox")
    @patch("agent.tools.verify_pr._plan_commands_with_model", return_value=None)
    def test_npm_ci_eresolve_falls_back_to_install(
        self, _mock_plan, mock_create_sandbox, mock_fetch_pr, mock_get_token, mock_get_config
    ) -> None:
        """Test npm repos retry with install when npm ci hits ERESOLVE."""
        mock_get_config.return_value = {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {"owner": "testowner", "name": "testrepo"},
            },
        }
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {
                "ref": "feature/test",
                "repo": {"clone_url": "https://github.com/testowner/testrepo.git"},
            },
        }

        mock_sandbox = MagicMock()
        mock_create_sandbox.return_value = mock_sandbox

        package_json = _json.dumps({"name": "ts-repo", "scripts": {"test": "vitest run"}})

        def execute_side_effect(cmd, **kwargs):
            result = MagicMock()
            if "git clone" in cmd or "git checkout" in cmd or "chmod 600" in cmd:
                result.exit_code = 0
                result.output = ""
            elif "test -f Makefile" in cmd:
                result.exit_code = 1
                result.output = ""
            elif "test -f package.json" in cmd or "test -f package-lock.json" in cmd:
                result.exit_code = 0
                result.output = ""
            elif "test -f " in cmd:
                result.exit_code = 1
                result.output = ""
            elif "head -c" in cmd and "package.json" in cmd:
                result.exit_code = 0
                result.output = package_json
            elif "npm ci" in cmd:
                result.exit_code = 1
                result.output = "npm error code ERESOLVE\nnpm error ERESOLVE could not resolve"
            elif "npm install --legacy-peer-deps" in cmd:
                result.exit_code = 0
                result.output = "installed"
            elif "npm test" in cmd:
                result.exit_code = 0
                result.output = "ok"
            else:
                result.exit_code = 0
                result.output = ""
            return result

        mock_sandbox.execute.side_effect = execute_side_effect

        with patch("agent.tools.verify_pr.post_github_comment", return_value=True):
            result = verify_pr(pr_number=123, add_labels=False)

        executed_commands = [call.args[0] for call in mock_sandbox.execute.call_args_list]
        assert result["success"] is True
        assert result["status"] == "passed"
        assert any("npm ci" in cmd for cmd in executed_commands)
        assert any("npm install --legacy-peer-deps" in cmd for cmd in executed_commands)
        assert any("npm test" in cmd for cmd in executed_commands)

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    @patch("agent.tools.verify_pr.create_sandbox")
    @patch("agent.tools.verify_pr._plan_commands_with_model", return_value=None)
    def test_javascript_repo_without_scripts_is_blocked(
        self, _mock_plan, mock_create_sandbox, mock_fetch_pr, mock_get_token, mock_get_config
    ) -> None:
        """Test that package repos without runnable scripts are not marked verified."""
        mock_get_config.return_value = {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {"owner": "testowner", "name": "testrepo"},
            },
        }
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {
                "ref": "feature/test",
                "repo": {"clone_url": "https://github.com/testowner/testrepo.git"},
            },
        }

        mock_sandbox = MagicMock()
        mock_create_sandbox.return_value = mock_sandbox

        package_json = _json.dumps({"name": "ts-repo", "scripts": {"dev": "vite"}})

        def execute_side_effect(cmd, **kwargs):
            result = MagicMock()
            if "git clone" in cmd or "git checkout" in cmd or "chmod 600" in cmd:
                result.exit_code = 0
                result.output = ""
            elif "test -f Makefile" in cmd:
                result.exit_code = 1
                result.output = ""
            elif "test -f package.json" in cmd or "test -f pnpm-lock.yaml" in cmd:
                result.exit_code = 0
                result.output = ""
            elif "test -f " in cmd:
                result.exit_code = 1
                result.output = ""
            elif "head -c" in cmd and "package.json" in cmd:
                result.exit_code = 0
                result.output = package_json
            else:
                result.exit_code = 0
                result.output = ""
            return result

        mock_sandbox.execute.side_effect = execute_side_effect

        with patch("agent.tools.verify_pr.post_github_comment", return_value=True):
            result = verify_pr(pr_number=123, add_labels=False)

        assert result["success"] is False
        assert result["status"] == "blocked"
        assert result["planned_commands"]["verify"] == []

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    @patch("agent.tools.verify_pr.create_sandbox")
    def test_clone_failure_handling(
        self, mock_create_sandbox, mock_fetch_pr, mock_get_token, mock_get_config
    ) -> None:
        """Test handling of git clone failure."""
        mock_get_config.return_value = {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {"owner": "testowner", "name": "testrepo"},
            },
        }
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {
                "ref": "feature/test",
                "repo": {"clone_url": "https://github.com/testowner/testrepo.git"},
            },
        }

        # Setup sandbox - clone fails
        mock_sandbox = MagicMock()
        mock_create_sandbox.return_value = mock_sandbox

        clone_result = MagicMock()
        clone_result.exit_code = 128
        clone_result.output = "fatal: Could not read from remote repository"
        mock_sandbox.execute.return_value = clone_result

        result = verify_pr(pr_number=123)

        assert result["success"] is False
        assert "Failed to clone repository" in result["error"]

    @patch("agent.tools.verify_pr.get_config")
    @patch("agent.tools.verify_pr.get_github_app_installation_token")
    @patch("agent.tools.verify_pr._fetch_pr_details")
    @patch("agent.tools.verify_pr.create_sandbox")
    def test_checkout_failure_handling(
        self, mock_create_sandbox, mock_fetch_pr, mock_get_token, mock_get_config
    ) -> None:
        """Test handling of git checkout failure."""
        mock_get_config.return_value = {
            "configurable": {
                "thread_id": "test-thread-123",
                "repo": {"owner": "testowner", "name": "testrepo"},
            },
        }
        mock_get_token.return_value = "fake-token"
        mock_fetch_pr.return_value = {
            "number": 123,
            "head": {
                "ref": "feature/test",
                "repo": {"clone_url": "https://github.com/testowner/testrepo.git"},
            },
        }

        # Setup sandbox - clone succeeds but checkout fails
        mock_sandbox = MagicMock()
        mock_create_sandbox.return_value = mock_sandbox

        def execute_side_effect(cmd, **kwargs):
            result = MagicMock()
            if "git clone" in cmd:
                result.exit_code = 0
                result.output = ""
            elif "git checkout" in cmd:
                result.exit_code = 1
                result.output = "error: pathspec 'feature/test' did not match"
            else:
                result.exit_code = 0
                result.output = ""
            return result

        mock_sandbox.execute.side_effect = execute_side_effect

        result = verify_pr(pr_number=123)

        assert result["success"] is False
        assert "Failed to checkout branch" in result["error"]
