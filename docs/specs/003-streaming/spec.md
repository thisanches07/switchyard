# Spec 003: Streaming (SSE) and embeddings

- **Status:** Draft (review, then change to Approved)
- **Owner:** @thisanches07
- **Release:** v0.1
- **Depends on:** 002
- **Related ADRs:** 0003 (OpenAI-compatible API), 0004 (canonical format + adapters), 0005 (embeddings model), 0008 (no retry after first byte), 0010 (no content in logs), 0011 (OpenTelemetry)

## Problem
Chat apps stream: users expect tokens to appear as they are generated, and most SDK integrations call `stream: true` by default. Today the gateway rejects streaming with 400, so those clients cannot use it. The gateway also has no `/v1/embeddings`, which the semantic cache (spec 009) and any RAG workload need.

Streaming is where a proxy can quietly do damage: buffering kills time-to-first-token, a vanished client can leave an expensive upstream generation running, and a failure halfway through a stream cannot be retried (ADR-0008). This spec makes those behaviours explicit and tested.

## User stories
- As an **application developer**, I want `stream: true` to work exactly as with OpenAI, so chat UIs render tokens as they arrive.
- As an **operator**, I want token usage and time-to-first-token recorded for streamed requests too, so costs and latency stay visible.
- As an **operator**, I want the upstream generation cancelled when the client disconnects, so abandoned requests don't burn tokens.
- As a **RAG developer**, I want an OpenAI-compatible `/v1/embeddings` endpoint behind the same aliases, errors and telemetry.

## Acceptance criteria (EARS)

### Streaming
- **AC-1** WHEN a client sends `POST /v1/chat/completions` with `stream: true` and the provider starts streaming, THE gateway SHALL respond `200` with `content-type: text/event-stream` and forward each upstream chunk as an OpenAI SSE event (`data: {chat.completion.chunk}\n\n`), ending with `data: [DONE]\n\n`.
- **AC-2** THE gateway SHALL forward each chunk as soon as it is received, without buffering the response: given a provider that emits chunks 200 ms apart, the client SHALL receive the first chunk before the provider has sent the last one.
- **AC-3** WHEN the first upstream chunk is received, THE gateway SHALL send the response headers including `x-switchyard-request-id`, `x-switchyard-provider`, `x-switchyard-model` and `x-switchyard-ttfb-ms` (time from upstream request to first chunk).
- **AC-4** IF the provider fails, times out or the model cannot be resolved **before the first byte is sent to the client**, THEN THE gateway SHALL respond with the same status and OpenAI JSON error as the non-streaming path (spec 002).
- **AC-5** IF the provider fails or stops sending for longer than `server.timeouts.ttfbMs` **after the first byte was sent**, THEN THE gateway SHALL send one SSE event `data: {"error":{…}}` with `code` `upstream_error` or `upstream_timeout`, then end the stream, SHALL NOT retry or fall back (ADR-0008), and SHALL record the request with status `upstream_error_midstream`.
- **AC-6** WHEN the client disconnects before the stream ends, THE gateway SHALL abort the upstream request within 1 s and record the request with status `499`.
- **AC-7** WHEN forwarding a streaming request, THE gateway SHALL ask the provider for usage (`stream_options.include_usage: true`); the final usage chunk SHALL be forwarded to the client only if the client asked for it. IF the provider reports no usage, THEN THE gateway SHALL estimate it (≈ 4 characters per token) and mark the span attribute `switchyard.usage.estimated=true`.
- **AC-8** WHEN a streamed request completes, THE gateway SHALL record the `switchyard.upstream` span (with usage), `switchyard_requests_total`, `switchyard_upstream_duration_seconds` and a new `switchyard_ttfb_seconds` histogram (`provider`, `model`), without recording content (ADR-0010).
- **AC-9** THE `mock` provider SHALL stream a deterministic sequence of chunks with a configurable delay between chunks, and a model named `error-midstream` SHALL fail after sending at least one chunk (for tests).

### Embeddings
- **AC-10** WHEN a client sends `POST /v1/embeddings` with `model` and `input` (a string or an array of strings), THE gateway SHALL resolve the model like chat (alias or `provider/model`), forward the request to the provider's `/embeddings` endpoint and return the OpenAI `list` of `embedding` objects with `usage`, with the same headers and error mapping as spec 002.
- **AC-11** THE `mock` provider SHALL return deterministic embeddings of 768 dimensions (ADR-0005) for each input, and THE `switchyard.upstream` span SHALL use `gen_ai.operation.name=embeddings`.
- **AC-12** THE example config SHALL define an `embed` alias pointing to `ollama/nomic-embed-text`.

### Compatibility
- **AC-13** WHEN the contract suites run, THE official OpenAI **Node** and **Python** SDKs SHALL stream a chat completion and create embeddings through the gateway against the `mock` provider (always, in CI) and against Ollama (skipped with a clear message when Ollama or the model is not available).

## Non-goals
- Fallback or retries for streams (spec 008; and never after the first byte, ADR-0008).
- Streaming for the `anthropic` provider type (still 501 until spec 014).
- Restoring masked PII inside streamed responses (stretch spec 015).
- Legacy `/v1/completions` and audio/image endpoints.
- Base64 `encoding_format` for embeddings: passed through to OpenAI-compatible providers, but the mock always returns floats.

## Open questions
- Should a stream that exceeds `server.timeouts.totalMs` be cut, or should streams only be bounded by the idle (between-chunk) timeout? (Proposed: only the idle timeout applies once streaming has started, because long generations are legitimate; `totalMs` keeps applying before the first chunk.)
- Should SSE comment heartbeats (`: ping`) be sent while waiting for the first chunk, to keep proxies from closing idle connections? (Proposed: not in this spec; revisit with the deploy in spec 013.)
