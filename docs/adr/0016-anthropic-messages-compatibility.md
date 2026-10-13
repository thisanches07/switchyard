# 0016. Add an Anthropic Messages surface translated through the canonical format

- **Status:** Accepted
- **Date:** 2026-10-13
- **Related specs:** 014 (also affects 006, 007, 008, 009, 010)

## Context
ADR-0003 makes the OpenAI API the public surface and fixes the OpenAI error shape; ADR-0004 makes every feature (rate limiting, usage, budgets, caching, PII redaction) operate on one canonical, OpenAI-shaped request. Spec 014 adds two things that push against both:

1. an outbound `anthropic` adapter, so `claude/...` candidates work behind `/v1/chat/completions`;
2. an inbound `POST /v1/messages` for clients built on the official Anthropic SDKs, which expect Anthropic's request, streaming and error formats (`{"type":"error","error":{"type","message"}}`, named SSE events, `529 overloaded_error`).

Two questions need a decision:
- **Error shape:** ADR-0003 says "the OpenAI error shape" for the public surface. The Anthropic SDKs map errors by HTTP status, but they parse and expose the Anthropic body, and a client that inspects `error.type` would break on the OpenAI shape.
- **Translation path for `/v1/messages`:** when inbound and outbound are both Anthropic (the common case for these clients), forwarding the body natively keeps everything (thinking blocks that must be echoed back unchanged, `cache_control` markers, documents, citations, `top_k`, beta features). Routing it through the canonical format is what lets PII redaction (spec 010, same wave), cost and budgets (007) and caching (009) apply to it.

## Options considered
1. **Native pass-through when both sides are Anthropic, canonical otherwise.** Full fidelity on the main path, no translation cost. But that path silently skips every cross-cutting feature that works on the canonical request (PII redaction above all), or each feature grows an Anthropic branch, which is exactly the N×M problem ADR-0004 rejected.
2. **Always translate through the canonical format, dropping what it cannot express.** One path for every feature, but the same-family path loses thinking blocks, `cache_control` and documents, which breaks tool loops on models with mandatory thinking and removes prompt caching for Anthropic users.
3. **Always translate through the canonical format, carrying Anthropic-only data opaquely.** Normalise into the canonical request (the fields every feature reads: roles, text content, tool calls, tool results, limits) and attach the Anthropic-only parts (`thinking`/`redacted_thinking` blocks, `cache_control`, `document` blocks, `top_k`, `metadata`, beta header) as an extension the canonical types already allow (they keep unknown fields). The `anthropic` adapter re-emits them; adapters for other families drop or reject them per the table below.

For errors:
- **A. OpenAI shape everywhere** (strict ADR-0003): simpler, but Anthropic SDK users get bodies their SDK does not describe.
- **B. Shape chosen by the route the client called**, never by the provider: OpenAI shape on `/v1/chat/completions` and `/v1/embeddings`, Anthropic shape on `/v1/messages`.

## Decision
We choose **option 3** for translation and **option B** for errors.

- Every request, on every route, becomes a canonical request; PII redaction, rate limiting, usage events, budgets and caching see the same canonical fields regardless of the route. **PII redaction (spec 010) applies to `/v1/messages`**: it scans and masks the canonical text content (text blocks and `system`, `tool_result` text), and the masking is reflected in what the adapter sends. Opaque Anthropic-only data (thinking blocks, `document` blocks) is not scanned; spec 010 decides how to treat it (see Consequences).
- On the same-family path (`/v1/messages` → `anthropic`), the adapter re-emits the opaque parts unchanged, so thinking blocks round-trip byte for byte and prompt caching keeps working. Streams on that path forward upstream events unchanged except `model`.
- The error body is produced at the edge of each route from the same `GatewayError` (status, type, code, message). On `/v1/messages`, `error.type` is derived from the HTTP status using Anthropic's documented types, `request_id` carries `x-switchyard-request-id`, and the gateway's own `code` goes into `error.details.error_code`. Providers never decide the shape.
- ADR-0003 stays Accepted: the OpenAI surface is still the primary one and is not changed. This ADR adds a second, explicitly scoped surface.

### Lossy features (fixed table; anything not listed is passed through or translated)

| Feature | `/v1/chat/completions` → `anthropic` | `/v1/messages` → non-Anthropic |
|---|---|---|
| `n > 1`, `logprobs`, `top_logprobs` | 400 `unsupported_parameter` | n/a |
| `response_format` (`json_object`, `json_schema`) | 400 `unsupported_parameter` | n/a |
| `presence_penalty`, `frequency_penalty`, `seed`, `logit_bias` | dropped, listed in `switchyard.dropped_params` | n/a |
| Thinking / reasoning content | dropped from the response | `thinking`/`redacted_thinking` in earlier turns dropped; none produced |
| `cache_control` markers | n/a (none in OpenAI requests) | dropped |
| `cache_read` / `cache_creation` usage | folded into `prompt_tokens`; reads in `cached_tokens` | not reported (0) |
| `document` blocks (PDF, text) | n/a | 400 `invalid_request_error` |
| Server tools (web search, code execution, computer use) | n/a | 400 `invalid_request_error` |
| `top_k` | n/a | passed through; provider may reject |
| `stop_reason` `pause_turn`, `refusal`, `model_context_window_exceeded` | `stop`, `content_filter`, `length` | produced only as `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `refusal` |
| Embeddings | 400 `embeddings_not_supported` | n/a |

## Consequences
- ✅ One request path: every feature from specs 005–010 applies to Anthropic-SDK traffic without Anthropic-specific branches.
- ✅ Anthropic SDK users keep full fidelity on the same-family path (thinking, prompt caching, documents) and get errors their SDK documents.
- ✅ The error contract stays simple to reason about: the route decides the shape, so tests per route are enough.
- ⚠️ Two public error shapes and two SSE formats to maintain, and two sets of contract tests (OpenAI and Anthropic SDKs).
- ⚠️ The canonical types carry an Anthropic extension; features must treat it as opaque and must not read it. PII redaction does not see thinking content or document blocks; spec 010 must decide whether to reject such requests in `block` mode.
- ⚠️ Thinking blocks cannot round-trip through `/v1/chat/completions`. On models with mandatory thinking, multi-turn tool loops through the OpenAI surface may be rejected upstream (spec 014 open question); this is the main known gap.
- ⚠️ The semantic and exact caches (spec 009) see the canonical request only; two `/v1/messages` requests differing only in opaque fields could share a cache entry unless 009 includes the extension in its key. Recorded for spec 009.
- 🔁 Revisit if Anthropic-only features become core requirements (e.g. citations or server tools across providers), if an OpenAI-side standard for reasoning content round-trips emerges, or if the translation overhead shows up in the spec 012 benchmarks.
