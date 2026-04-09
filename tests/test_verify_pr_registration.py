import inspect

from agent import server


def test_server_does_not_register_verify_pr_after_agent() -> None:
    source = inspect.getsource(server.get_agent)

    assert "verify_pr_after_agent" not in source
