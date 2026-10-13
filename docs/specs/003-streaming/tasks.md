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

- [ ] **T4. Mock streaming and embeddings**
  - ACs: AC-9, AC-11
  - Test: `mock.test.ts` › chunk sequence, delay honoured, usage chunk when requested, `error-midstream` fails after a chunk, `error-500` rejects before streaming; embeddings deterministic 768-dim, normalised, base64 round-trip.

- [ ] **T5. undici streaming client**
  - ACs: AC-2, AC-5, AC-6 (transport)
  - Test: `test/integration/upstream-http.int.test.ts` › `postStream` yields bytes as sent, non-2xx returns text, idle timeout mid-body → `UpstreamTimeoutError`, caller abort stops the body.
  - Files: `src/infra/http/undici-client.ts`

- [ ] **T6. OpenAI-compatible streaming and embeddings**
  - ACs: AC-1, AC-4, AC-5, AC-7, AC-10
  - Test: `openai-compatible.test.ts` › stream body has `stream_options.include_usage`, chunks parsed, pre-stream 4xx/5xx mapped, mid-stream network/timeout → gateway errors with the right code, invalid JSON chunk → `upstream_error`; embeddings URL/body/usage/errors.

- [ ] **T7. Upstream span handle and TTFB metric**
  - ACs: AC-8, AC-11
  - Test: `telemetry.test.ts` › stream span attributes (`switchyard.stream`, ttfb, usage, estimated flag), `switchyard_ttfb_seconds`, statuses `upstream_error_midstream`/`499`, embeddings operation name; non-streaming behaviour unchanged.
  - Files: `src/modules/proxy/telemetry.ts`

- [ ] **T8. Streaming route**
  - ACs: AC-1, AC-3, AC-4, AC-5, AC-7
  - Test: `test/unit/proxy/stream.test.ts` › SSE events and `[DONE]`, headers incl. ttfb, pre-first-chunk errors as JSON, mid-stream error event without `[DONE]`, usage forwarding rules.
  - Files: `src/modules/proxy/{stream,routes,schema}.ts`

- [ ] **T9. Streaming over a real socket**
  - ACs: AC-2, AC-6
  - Test: `test/integration/streaming.int.test.ts` › first chunk arrives before the provider finishes; client abort → upstream aborted < 1 s and status 499.

- [ ] **T10. Embeddings route**
  - ACs: AC-10
  - Test: `test/unit/proxy/embeddings.test.ts` › alias resolution, string and array input, invalid input 400, unknown model 404, headers, upstream errors.

- [ ] **T11. Node SDK contract: streaming and embeddings**
  - ACs: AC-13
  - Test: `openai-sdk.contract.test.ts` › stream on mock (content and usage), embeddings on mock (default base64 decoding and explicit float), Ollama stream and `nomic-embed-text` embeddings when available.

- [ ] **T12. Python SDK contract**
  - ACs: AC-13
  - Do: `scripts/contract-python.ts` starts the gateway and runs pytest; `pnpm test:contract:py`; CI job with `actions/setup-python`.
  - Test: `test/contract/python/test_openai_sdk.py` › chat, stream, embeddings on mock; Ollama cases when available.

- [ ] **T13. Smoke, docs and verification**
  - Do: smoke step for a streamed request; README (features, quickstart streaming example, roadmap); backlog status; verification table.
  - Test: `pnpm verify`, `pnpm test:int`, `pnpm test:contract`, `pnpm test:contract:py`, `pnpm test:smoke`.
