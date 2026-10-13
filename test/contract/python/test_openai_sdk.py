"""Official OpenAI Python SDK against Switchyard (spec 003, AC-13).

Run through `pnpm test:contract:py`, which starts the gateway and sets SWITCHYARD_BASE_URL.
"""

import os

import openai
import pytest
from openai import OpenAI

BASE_URL = os.environ["SWITCHYARD_BASE_URL"]
API_KEY = os.environ["SWITCHYARD_API_KEY"]
OLLAMA_CHAT = os.environ.get("OLLAMA_CHAT") == "1"
OLLAMA_EMBED = os.environ.get("OLLAMA_EMBED") == "1"


@pytest.fixture(scope="module")
def client() -> OpenAI:
    return OpenAI(base_url=BASE_URL, api_key=API_KEY, max_retries=0)


def test_chat_through_alias(client: OpenAI) -> None:
    res = client.chat.completions.with_raw_response.create(
        model="fast", messages=[{"role": "user", "content": "Say hi"}]
    )
    completion = res.parse()
    assert completion.choices[0].message.content == "This is a mock response."
    assert res.headers["x-switchyard-provider"] == "mock"


def test_invalid_key_is_authentication_error() -> None:
    anonymous = OpenAI(base_url=BASE_URL, api_key="sk-sy-wrong", max_retries=0)
    with pytest.raises(openai.AuthenticationError):
        anonymous.models.list()


def test_unknown_model_is_not_found(client: OpenAI) -> None:
    with pytest.raises(openai.NotFoundError) as info:
        client.chat.completions.create(model="gpt-9", messages=[{"role": "user", "content": "x"}])
    assert info.value.code == "model_not_found"


def test_stream_with_usage(client: OpenAI) -> None:
    stream = client.chat.completions.create(
        model="fast",
        messages=[{"role": "user", "content": "Say hi"}],
        stream=True,
        stream_options={"include_usage": True},
    )
    text = ""
    usage = None
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            text += chunk.choices[0].delta.content
        if chunk.usage:
            usage = chunk.usage
    assert text == "This is a mock response."
    assert usage is not None and usage.completion_tokens == 6


def test_midstream_failure_raises_while_iterating(client: OpenAI) -> None:
    stream = client.chat.completions.create(
        model="mock/error-midstream",
        messages=[{"role": "user", "content": "x"}],
        stream=True,
    )
    with pytest.raises(openai.APIError):
        for _ in stream:
            pass


def test_embeddings_default_encoding(client: OpenAI) -> None:
    res = client.embeddings.create(model="mock/embed", input=["a", "b"])
    assert len(res.data) == 2
    assert len(res.data[0].embedding) == 768
    assert isinstance(res.data[0].embedding[0], float)


def test_embeddings_float_encoding(client: OpenAI) -> None:
    res = client.embeddings.create(model="mock/embed", input="a", encoding_format="float")
    assert len(res.data[0].embedding) == 768
    assert res.usage.prompt_tokens > 0


@pytest.mark.skipif(not OLLAMA_CHAT, reason="Ollama chat model not available")
def test_stream_on_ollama(client: OpenAI) -> None:
    stream = client.chat.completions.create(
        model="local",
        messages=[{"role": "user", "content": "Count from 1 to 5."}],
        stream=True,
    )
    chunks = sum(1 for _ in stream)
    assert chunks > 2


@pytest.mark.skipif(not OLLAMA_EMBED, reason="Ollama embedding model not available")
def test_embeddings_on_ollama(client: OpenAI) -> None:
    res = client.embeddings.create(model="embed", input=["hello", "world"])
    assert len(res.data) == 2
    assert len(res.data[0].embedding) == 768
