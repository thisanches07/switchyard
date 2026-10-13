# Spec 002: Chat proxy (non-streaming)

- **Status:** Done (2026-10-13); CI run pending first push
- **Owner:** @thisanches07
- **Release:** v0.1
- **Depends on:** 001
- **Related ADRs:** 0003 (OpenAI-compatible API), 0004 (canonical format + adapters), 0010 (no content in logs), 0011 (OpenTelemetry)

## Problem
The gateway boots but cannot do its core job yet: take an OpenAI-style chat request, send it to a configured provider and return the answer. Everything later in v0.1 (keys, limits, usage events, budgets, routing) wraps this path, so it must exist first, be provider-agnostic internally and be proven compatible with the official OpenAI SDK.

## User stories
- As an **application developer**, I want to point the official OpenAI SDK at Switchyard by changing only `baseURL`, so I can adopt it without code changes.
- As an **application developer**, I want to call a model by alias (`local`, `fast`) or by `provider/model`, so my code doesn't depend on which provider serves it.
- As an **operator**, I want to see which provider and model served each request, and how long the upstream took, in headers and traces.
- As a **maintainer**, I want a mock provider with controllable latency and failures, so tests and benchmarks don't depend on real models.

## Acceptance criteria (EARS)
- **AC-1** WHEN a client sends `POST /v1/chat/completions` with a valid OpenAI chat body and `model` set to an alias, THE gateway SHALL forward it to the alias's **first** candidate and return the provider's response in OpenAI `chat.completion` format with status 200.
- **AC-2** WHEN `model` is `provider/model` for a configured provider, THE gateway SHALL forward it to that provider with the model part unchanged (model IDs may contain `/`).
- **AC-3** IF `model` matches neither an alias nor a configured `provider/model`, THEN THE gateway SHALL respond 404 with `{"error":{"type":"invalid_request_error","code":"model_not_found",…}}` and SHALL NOT call any provider.
- **AC-4** IF the request body is not valid JSON or fails validation (missing `model` or `messages`, wrong types), THEN THE gateway SHALL respond 400 with `type: "invalid_request_error"` and a message naming the offending field. IF `stream` is `true`, THEN it SHALL respond 400 with `code: "stream_not_supported"` (until spec 003).
- **AC-5** WHEN forwarding to an `openai-compatible` provider, THE gateway SHALL pass through request fields it does not interpret (e.g. `temperature`, `tools`, `response_format`, `seed`), and SHALL send the provider API key from the env var named in `apiKeyEnv` when one is configured.
- **AC-6** IF the provider responds 4xx, THEN THE gateway SHALL return the same status with the error in OpenAI shape; IF the provider responds 5xx or the connection fails, THEN it SHALL respond 502 `code: "upstream_error"`; IF the TTFB or total timeout from `server.timeouts` elapses, THEN it SHALL respond 504 `code: "upstream_timeout"`. No retries in this spec.
- **AC-7** WHEN a request completes (success or error), THE response SHALL include `x-switchyard-request-id`, and, when a provider was selected, `x-switchyard-provider` and `x-switchyard-model` (the resolved model).
- **AC-8** WHEN `GET /v1/models` is called, THE gateway SHALL return an OpenAI `list` of model objects containing every alias and every distinct `provider/model` referenced in config, with `owned_by` set to the provider name (`switchyard` for aliases).
- **AC-9** WHEN an upstream call is made, THE gateway SHALL record a `switchyard.upstream` span with `gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` (when the provider reports them), a `switchyard_requests_total{provider,model,status}` counter and a `switchyard_upstream_duration_seconds` histogram, and SHALL NOT put message content in logs or span attributes.
- **AC-10** THE `mock` provider SHALL return a deterministic response with reported usage, honour `latencyMs`, and fail with a provider 500 for a configurable fraction of requests (`errorRate`) or on demand per request (for tests).
- **AC-11** WHEN the contract test suite runs, THE official `openai` Node SDK SHALL complete a chat request through the gateway against the `mock` provider (always, in CI) and against Ollama (skipped with a clear message when Ollama is not reachable).
- **AC-12** THE `pnpm verify` gate SHALL fail if unit-test line coverage of `src/core` and `src/modules` drops below 80%.

## Non-goals
- Streaming (`stream: true`) and `/v1/embeddings`: spec 003.
- Authentication and virtual keys: spec 004. Until then `/v1/*` is unauthenticated; the README must say so and the default compose port binding stays local.
- Retries, fallback, circuit breakers, `lowest-cost` / `lowest-latency` strategies: spec 008 (this spec always uses the first candidate).
- Cost calculation and `x-switchyard-cost-usd`: spec 007. Cache headers: spec 009.
- The `anthropic` adapter: the config type already exists; requests resolved to it SHALL return 501 `code: "provider_not_implemented"` until spec 014.

## Open questions
- Should unknown request fields also be passed through to non-OpenAI providers in later specs, or rejected? (Proposed: decide per adapter in spec 014.)
- Should `x-switchyard-upstream-ms` (pure upstream time) be exposed as a header now, or only as a metric? (Proposed: header too; cheap and useful for debugging overhead before spec 012.)
