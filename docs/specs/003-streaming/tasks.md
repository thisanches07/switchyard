# Tasks 003: Streaming (SSE) and embeddings

- **Status:** Approved (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-003]`. `pnpm verify` green after each.

- [x] **T1. Port and type changes**
  - ACs: foundation for all
  - Do: `ChatChunk`, `ChatStream`, `EmbeddingsRequest/Result`, `HttpStreamResponse`; `chatStream`/`embeddings` on `ChatProvider`; failing provider implements them; mock `chunkDelayMs` in config schema; `embed` alias in the example config.
  - Test: `test/unit/providers/registry.test.ts` › failing providers reject `chatStream`/`embeddings` with 501/503; `schema.test.ts` › example config has `embed` alias and accepts `chunkDelayMs`.

- [x] **T2. SSE decoder**
  - ACs: AC-1 (provider side)
  - Test: `test/unit/providers/sse.test.ts` › splits events across arbitrary byte boundaries, `\r\n`, comments ignored, multi-line data joined, stops at `[DONE]`.
  - Files: `src/modules/providers/sse.ts`

- [x] **T3. Usage helpers**
  - ACs: AC-7
  - Test: `test/unit/proxy/usage.test.ts` › extract usage from chunks, strip usage when not requested, drop usage-only chunk, estimate tokens from messages and deltas.
  - Files: `src/modules/proxy/usage.ts`

- [x] **T4. Mock streaming and embeddings**
  - ACs: AC-9, AC-11
  - Test: `mock.test.ts` › chunk sequence, delay honoured, usage chunk when requested, `error-midstream` fails after a chunk, `error-500` rejects before streaming; embeddings deterministic 768-dim, normalised, base64 round-trip.

- [x] **T5. undici streaming client**
  - ACs: AC-2, AC-5, AC-6 (transport)
  - Test: `test/integration/upstream-http.int.test.ts` › `postStream` yields bytes as sent, non-2xx returns text, idle timeout mid-body → `UpstreamTimeoutError`, caller abort stops the body.
  - Files: `src/infra/http/undici-client.ts`

- [x] **T6. OpenAI-compatible streaming and embeddings**
  - ACs: AC-1, AC-4, AC-5, AC-7, AC-10
  - Test: `openai-compatible.test.ts` › stream body has `stream_options.include_usage`, chunks parsed, pre-stream 4xx/5xx mapped, mid-stream network/timeout → gateway errors with the right code, invalid JSON chunk → `upstream_error`; embeddings URL/body/usage/errors.

- [x] **T7. Upstream span handle and TTFB metric**
  - ACs: AC-8, AC-11
  - Test: `telemetry.test.ts` › stream span attributes (`switchyard.stream`, ttfb, usage, estimated flag), `switchyard_ttfb_seconds`, statuses `upstream_error_midstream`/`499`, embeddings operation name; non-streaming behaviour unchanged.
  - Files: `src/modules/proxy/telemetry.ts`

- [x] **T8. Streaming route**
  - ACs: AC-1, AC-3, AC-4, AC-5, AC-7
  - Test: `test/unit/proxy/stream.test.ts` › SSE events and `[DONE]`, headers incl. ttfb, pre-first-chunk errors as JSON, mid-stream error event without `[DONE]`, usage forwarding rules.
  - Files: `src/modules/proxy/{stream,routes,schema}.ts`

- [x] **T9. Streaming over a real socket**
  - ACs: AC-2, AC-6
  - Test: `test/integration/streaming.int.test.ts` › first chunk arrives before the provider finishes; client abort → upstream aborted < 1 s and status 499.

- [x] **T10. Embeddings route**
  - ACs: AC-10
  - Test: `test/unit/proxy/embeddings.test.ts` › alias resolution, string and array input, invalid input 400, unknown model 404, headers, upstream errors.

- [x] **T11. Node SDK contract: streaming and embeddings**
  - ACs: AC-13
  - Test: `openai-sdk.contract.test.ts` › stream on mock (content and usage), embeddings on mock (default base64 decoding and explicit float), Ollama stream and `nomic-embed-text` embeddings when available.

- [x] **T12. Python SDK contract**
  - ACs: AC-13
  - Do: `scripts/contract-python.ts` starts the gateway and runs pytest; `pnpm test:contract:py`; CI job with `actions/setup-python`.
  - Test: `test/contract/python/test_openai_sdk.py` › chat, stream, embeddings on mock; Ollama cases when available.

- [x] **T13. Smoke, docs and verification**
  - Do: smoke step for a streamed request; README (features, quickstart streaming example, roadmap); backlog status; verification table.
  - Test: `pnpm verify`, `pnpm test:int`, `pnpm test:contract`, `pnpm test:contract:py`, `pnpm test:smoke`.

## Verification (2026-10-13)

| AC | Proven by | Result |
|---|---|---|
| AC-1 | `test/unit/proxy/stream.test.ts` › SSE content type, chunks, `[DONE]`; contract (Node, Python) › stream through an alias | ✅ |
| AC-2 | `test/integration/streaming.int.test.ts` › first chunk arrives > 800 ms before the last (200 ms chunk delay, real socket) | ✅ |
| AC-3 | `stream.test.ts` › Switchyard headers including `x-switchyard-ttfb-ms` | ✅ |
| AC-4 | `stream.test.ts` › 404 / 502 / 429 as JSON before the first byte; `openai-compatible.test.ts` › pre-stream status and connection errors | ✅ |
| AC-5 | `stream.test.ts` › mid-stream error event without `[DONE]`, no retry; `openai-compatible.test.ts` › mid-stream timeout/network codes; `upstream-http.int.test.ts` › idle timeout; telemetry › `upstream_error_midstream` | ✅ |
| AC-6 | `streaming.int.test.ts` › client abort → upstream signal aborted < 1 s, status `499` recorded | ✅ |
| AC-7 | `test/unit/proxy/usage.test.ts`; `stream.test.ts` › usage chunk only when requested, provider always asked, estimation flag | ✅ |
| AC-8 | `test/unit/proxy/telemetry.test.ts` › stream span attributes, `switchyard_ttfb_seconds`, statuses; no content recorded | ✅ |
| AC-9 | `test/unit/providers/mock.test.ts` › stream sequence, `chunkDelayMs`, `error-midstream`, abort | ✅ |
| AC-10 | `test/unit/proxy/embeddings.test.ts`; `openai-compatible.test.ts` › embeddings URL, body, usage, errors | ✅ |
| AC-11 | `mock.test.ts` › 768 dims, deterministic, normalised, base64 round-trip; telemetry › `gen_ai.operation.name=embeddings` | ✅ |
| AC-12 | `test/unit/config/schema.test.ts` › example config defines `embed` | ✅ |
| AC-13 | Node SDK contract 11/11 and Python SDK contract 8/8, including Ollama `llama3.2` streaming and `nomic-embed-text` embeddings (GTX 1060) | ✅ |

Also run: `pnpm verify` (188 unit tests, coverage gate), `pnpm test:int` (16), `pnpm test:smoke` (10/10 steps, now with streaming and embeddings inside Docker).

Deviations recorded here:
- The mock honours `encoding_format: "base64"`: both official SDKs request base64 by default (spec non-goal corrected in the design).
- `stream_not_supported` (spec 002) was removed; `stream: true` is now served.
- The upstream tracer is looked up per call so tests that swap the global tracer provider are honoured.
