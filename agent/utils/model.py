import os

from langchain.chat_models import init_chat_model

OPENAI_RESPONSES_WS_BASE_URL = "wss://api.openai.com/v1"


def make_model(model_id: str, **kwargs: dict):
    model_kwargs = kwargs.copy()

    if model_id.startswith("openai:"):
        model_kwargs["base_url"] = OPENAI_RESPONSES_WS_BASE_URL
        model_kwargs["use_responses_api"] = True
    elif model_id.startswith("ollama:"):
        if base_url := os.getenv("OLLAMA_BASE_URL"):
            model_kwargs["base_url"] = base_url

    return init_chat_model(model=model_id, **model_kwargs)
