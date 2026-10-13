"""Official Anthropic Python SDK against Switchyard's /v1/messages (spec 014, AC-16).

Run through `pnpm test:contract:py`, which starts the gateway (mock provider plus a fake
Anthropic server behind the `smart` alias) and sets SWITCHYARD_ORIGIN.
"""

import os

import anthropic
import pytest
from anthropic import Anthropic

ORIGIN = os.environ["SWITCHYARD_ORIGIN"]
API_KEY = os.environ["SWITCHYARD_API_KEY"]
MOCK_TEXT = "This is a mock response."
FAKE_TEXT = "Hello from fake Claude."
TOOLS = [
    {
        "name": "get_weather",
        "description": "Current weather for a city",
        "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}},
    }
]
PATHS = [("fast", MOCK_TEXT), ("smart", FAKE_TEXT)]


@pytest.fixture(scope="module")
def client() -> Anthropic:
    return Anthropic(base_url=ORIGIN, api_key=API_KEY, max_retries=0)


@pytest.mark.parametrize(("model", "expected"), PATHS)
def test_create_message(client: Anthropic, model: str, expected: str) -> None:
    message = client.messages.create(
        model=model, max_tokens=100, messages=[{"role": "user", "content": "Say hi"}]
    )
    assert message.type == "message"
    assert message.model == model
    assert message.content[0].type == "text"
    assert message.content[0].text == expected
    assert message.usage.output_tokens > 0
    assert message._request_id is not None and message._request_id.startswith("req_")


@pytest.mark.parametrize(("model", "expected"), PATHS)
def test_stream_message(client: Anthropic, model: str, expected: str) -> None:
    with client.messages.stream(
        model=model, max_tokens=100, messages=[{"role": "user", "content": "Say hi"}]
    ) as stream:
        text = "".join(stream.text_stream)
        final = stream.get_final_message()
    assert text == expected
    assert final.content[0].text == expected
    assert final.stop_reason == "end_turn"
    assert final.usage.output_tokens > 0


@pytest.mark.parametrize(("model", "expected"), PATHS)
def test_tool_round_trip(client: Anthropic, model: str, expected: str) -> None:
    question = {"role": "user", "content": "Weather in Paris?"}
    first = client.messages.create(model=model, max_tokens=200, tools=TOOLS, messages=[question])
    assert first.stop_reason == "tool_use"
    tool_use = next(block for block in first.content if block.type == "tool_use")
    assert tool_use.name == "get_weather"
    second = client.messages.create(
        model=model,
        max_tokens=200,
        tools=TOOLS,
        messages=[
            question,
            {"role": "assistant", "content": first.content},
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": tool_use.id, "content": "18C and sunny"}
                ],
            },
        ],
    )
    assert second.stop_reason == "end_turn"
    assert second.content[0].text == expected


def test_invalid_key_is_authentication_error() -> None:
    anonymous = Anthropic(base_url=ORIGIN, api_key="sk-sy-wrong", max_retries=0)
    with pytest.raises(anthropic.AuthenticationError):
        anonymous.messages.create(
            model="fast", max_tokens=10, messages=[{"role": "user", "content": "x"}]
        )


def test_rate_limit_is_rate_limit_error() -> None:
    limited = Anthropic(
        base_url=ORIGIN, api_key=os.environ["SWITCHYARD_ANTHROPIC_LIMITED_KEY"], max_retries=0
    )
    params = {"model": "fast", "max_tokens": 10, "messages": [{"role": "user", "content": "x"}]}
    limited.messages.create(**params)
    with pytest.raises(anthropic.RateLimitError) as info:
        limited.messages.create(**params)
    assert int(info.value.response.headers["retry-after"]) >= 1
    assert info.value.body["error"]["type"] == "rate_limit_error"


def test_unknown_model_is_not_found(client: Anthropic) -> None:
    with pytest.raises(anthropic.NotFoundError) as info:
        client.messages.create(
            model="gpt-9", max_tokens=10, messages=[{"role": "user", "content": "x"}]
        )
    assert info.value.body["error"]["details"]["error_code"] == "model_not_found"


@pytest.mark.parametrize("model", ["mock/error-500", "claude/error-500", "claude/error-529"])
def test_upstream_failure_is_internal_server_error(client: Anthropic, model: str) -> None:
    with pytest.raises(anthropic.InternalServerError):
        client.messages.create(
            model=model, max_tokens=10, messages=[{"role": "user", "content": "x"}]
        )
