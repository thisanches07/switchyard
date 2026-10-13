# Tasks 014: Anthropic provider adapter and Messages API

- **Status:** Done (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-014]`. `pnpm verify` green after each.

- [x] **T1. Core, config and transport groundwork**
  - ACs: foundation (AC-1, AC-4, AC-5, AC-13)
  - Do: `src/core/anthropic.ts` (extension and native-event symbols, accessors); `Usage.cachedInputTokens?`; `ChatResult.native?`; optional `headers` on HTTP responses (undici returns them); `GatewayError` `retryable` option and new factories; `defaultMaxTokens` on `anthropic` providers; `@anthropic-ai/sdk` devDependency.
  - Test: `test/unit/core/errors.test.ts` › new factories and retryable flag; `test/unit/config/schema.test.ts` › `defaultMaxTokens` default 4096; `test/integration/upstream-http.int.test.ts` › response headers returned.

- [x] **T2. Outbound request translation**
  - ACs: AC-2, AC-3
  - Test: `test/unit/anthropic/outbound-request.test.ts` › system concatenation, role merging, max tokens precedence, stop, user, images (data URI, URL), tools and tool_choice table, parallel_tool_calls, tool_calls → tool_use, invalid arguments 400, tool messages → tool_result turn, rejected and dropped parameter tables.
  - Files: `src/modules/anthropic/outbound-request.ts`

- [x] **T3. Outbound response translation**
  - ACs: AC-3, AC-4
  - Test: `test/unit/anthropic/outbound-response.test.ts` › text, tool_use, mixed, thinking dropped, every stop_reason, usage with cache fields (fixtures in `test/fixtures/anthropic/`).
  - Files: `src/modules/anthropic/outbound-response.ts`

- [x] **T4. Upstream error mapping**
  - ACs: AC-13
  - Test: `test/unit/anthropic/upstream-errors.test.ts` › status table (400/403/404/413/422 pass-through, 401 → 502, 429 + retry-after, 529 → 503, 500 → 502, 504), retryable flags, `error` event types.
  - Files: `src/modules/anthropic/upstream-errors.ts`

- [x] **T5. Outbound stream translation**
  - ACs: AC-10, AC-12
  - Test: `test/unit/anthropic/outbound-stream.test.ts` › SSE fixtures: text, tool use, mixed, thinking (nothing emitted, role chunk deferred), `error` before and after content, usage from `message_start` + last `message_delta`, missing `message_stop` → error, ping/unknown ignored.
  - Files: `src/modules/anthropic/outbound-stream.ts`

- [x] **T6. Anthropic adapter and registry**
  - ACs: AC-1, AC-2 (span), AC-5, AC-10, AC-13
  - Test: `test/unit/providers/anthropic.test.ts` › URL/headers/body, default base URL, embeddings 400 without a call, stream chunks, error mapping incl. request-id span attribute and dropped params; `registry.test.ts` › anthropic built with key, 503 without; placeholder tests removed.
  - Files: `src/modules/providers/{anthropic,registry}.ts`

- [x] **T7. x-api-key authentication**
  - ACs: AC-6
  - Test: `test/unit/auth/keys.test.ts` › `extractApiKey` table; `authenticate.test.ts` › x-api-key accepted, both equal accepted, both differ → 401.
  - Files: `src/modules/auth/{keys,authenticate}.ts`

- [x] **T8. Messages schema and inbound request translation**
  - ACs: AC-6, AC-8
  - Test: `test/unit/anthropic/inbound-request.test.ts` › Zod errors name fields; system/string/blocks, tool_use ↔ tool_calls, tool_result → tool messages, images, thinking and cache_control dropped, tool_choice reverse, top_k/metadata, blockers (document, server tools, tool_result images).
  - Files: `src/modules/anthropic/{schema,inbound-request}.ts`

- [x] **T9. Same-family native rebuild**
  - ACs: AC-7
  - Test: `test/unit/anthropic/native.test.ts` › byte-for-byte fixture (thinking, redacted_thinking, document, cache_control, system blocks, top_k, metadata, tools, tool_choice) with only `model` changed; masked canonical text written back; edited arguments written back as input.
  - Files: `src/modules/anthropic/native.ts`; adapter uses it.

- [x] **T10. Inbound response, error body and rate-limit headers**
  - ACs: AC-8, AC-9, AC-14
  - Test: `test/unit/anthropic/inbound-response.test.ts` › finish_reason table, stop_sequence match, tool calls, usage, `msg_` id; `inbound-errors.test.ts` › status → type table, details.error_code, request_id, anthropic-ratelimit-* from x-ratelimit-* (RFC 3339 reset).
  - Files: `src/modules/anthropic/{inbound-response,inbound-errors}.ts`

- [x] **T11. Stream encoder and Anthropic SSE**
  - ACs: AC-11, AC-12
  - Test: `test/unit/anthropic/inbound-stream.test.ts` › synthesised event order (text, tool use, mixed), native forwarding with model rewritten, error event shape; `test/unit/proxy/stream.test.ts` unchanged (default encoder).
  - Files: `src/modules/proxy/stream.ts`, `src/modules/anthropic/inbound-stream.ts`

- [x] **T12. POST /v1/messages route**
  - ACs: AC-6, AC-7, AC-8, AC-9, AC-11, AC-12, AC-14
  - Test: `test/unit/proxy/messages.test.ts` › cross-family via mock (message, stream), same-family via fake HTTP (response unchanged, model rewritten), blockers, rate-limit headers and 429, every error class in Anthropic shape with request-id, chat errors keep OpenAI shape, mid-stream error event, request span attributes; `openapi.test.ts` › `/v1/messages` documented.
  - Files: `src/modules/proxy/{messages,routes}.ts`, `src/app.ts`, `src/modules/docs.ts`

- [x] **T13. Mock tool calls**
  - ACs: AC-16 (enabler)
  - Test: `test/unit/providers/mock.test.ts` › tools present and last message not a tool result → tool call (non-stream and stream); otherwise text.
  - Files: `src/modules/providers/mock.ts`

- [x] **T14. Fake Anthropic server, integration and live tests**
  - ACs: AC-15
  - Test: `test/integration/anthropic.int.test.ts` › real HTTP: request headers/body (AC-1 to AC-3), streaming, 429/529/500 mapping, same-family byte-for-byte; `test/contract/anthropic-live.contract.test.ts` › skipped with a message unless `ANTHROPIC_API_KEY` and `SWITCHYARD_LIVE_ANTHROPIC=1`.
  - Files: `test/helpers/fake-anthropic.ts`

- [x] **T15. Node SDK contracts**
  - ACs: AC-16
  - Test: `test/contract/anthropic-sdk.contract.test.ts` › create, stream + `finalMessage()`, tool round trip, RateLimitError/AuthenticationError/NotFoundError/InternalServerError on mock; same-family on the fake server; `openai-sdk.contract.test.ts` › plain, streamed and tool calls routed to the fake Anthropic server.

- [x] **T16. Python SDK contract**
  - ACs: AC-16
  - Do: `anthropic` pinned in `test/contract/python/requirements.txt`; `scripts/contract-python.ts` starts the fake Anthropic server and configures a `claude` provider.
  - Test: `test/contract/python/test_anthropic_sdk.py` › same cases as T15 with `get_final_message()`.

- [x] **T17. Docs and verification**
  - Do: README (Anthropic section: both directions, limitations incl. thinking blocks, `defaultMaxTokens`), example config, architecture doc; verification table below.
  - Test: `pnpm verify`, `pnpm test:int`, `pnpm test:contract`, `pnpm test:contract:py`.

- [x] **T18. Wire `/v1/messages` into the outcome hook and PII stage** (after specs 006 and 010 merged)
  - ACs: AC-9 (outcome hook, `operation: "messages"`, `cachedInputTokens` from `cache_read_input_tokens`), ADR-0016 (PII on `/v1/messages`)
  - Do: in `src/modules/proxy/messages.ts`, call 006's hook on the same settle/stream paths chat uses (both already go through `settle()`/`streamChat()`); read `cachedInputTokens` from `Usage` (non-stream) and from the canonical usage chunk (stream); call 010's PII stage on the canonical request after admission; keep the extension (spread, not clone).
  - Test: `test/unit/proxy/messages-usage.test.ts` › one usage event per admitted request with `operation: "messages"` and cached tokens; PII mask on cross-family and same-family (masked text reaches the upstream body, thinking untouched); `block` mode → Anthropic-shaped 400 `pii_detected`; `native.test.ts` fixture still byte-for-byte with PII `off`.

## Verification (2026-10-13, rebased on specs 006 and 010)

| AC | Proven by | Result |
|---|---|---|
| AC-1 | `test/unit/providers/anthropic.test.ts` › URL and headers; `registry.test.ts` › default base URL, 503 `provider_not_configured` without the key; `anthropic.int.test.ts` › headers recorded by the fake server | ✅ |
| AC-2 | `test/unit/anthropic/outbound-request.test.ts` (system, merging, max tokens, stop, user, images, rejected and dropped tables); `anthropic.test.ts` › `switchyard.dropped_params` span attribute | ✅ |
| AC-3 | `outbound-request.test.ts` › tools, tool_choice, parallel_tool_calls, tool_calls ↔ tool_use, tool results, `invalid_tool_arguments`; `outbound-response.test.ts` › tool_use, mixed, thinking dropped; OpenAI contract › tool round trip on the fake server | ✅ |
| AC-4 | `outbound-response.test.ts` › every `stop_reason`, cache-aware usage and `cached_tokens` | ✅ |
| AC-5 | `anthropic.test.ts` › embeddings → 400 `embeddings_not_supported`, no upstream call | ✅ |
| AC-6 | `inbound-request.test.ts` › Zod errors name the field; `authenticate.test.ts`, `keys.test.ts` › `x-api-key`, both headers equal/different; `messages.test.ts`; `openapi.test.ts` › `/v1/messages` and the `x-api-key` scheme | ✅ |
| AC-7 | `native.test.ts` › byte-for-byte fixture (thinking, redacted_thinking, document, cache_control, system blocks, top_k, metadata, tools, tool_choice), masked text written back; `messages.test.ts` › same-family response with requested model, `anthropic-beta`; `anthropic.int.test.ts` › raw upstream bytes over HTTP | ✅ |
| AC-8 | `inbound-request.test.ts`, `inbound-response.test.ts` (tables, blockers, `msg_` ids, stop sequences); `messages.test.ts` › cross-family message and 400 blockers | ✅ |
| AC-9 | `messages.test.ts` › `anthropic-ratelimit-*` on success and 429 with `retry-after`, `max_tokens` allowance, request span `gen_ai.operation.name=chat` + `switchyard.api=anthropic` without content; `messages-usage.test.ts` › exactly one usage event with `operation: "messages"` for success, stream success, pre-first-byte failure, mid-stream failure, client disconnect and PII `rejected`, none before admission; `cachedInputTokens` from `cache_read_input_tokens` (same-family message and stream, and `/v1/chat/completions` → anthropic) | ✅ |
| AC-10 | `outbound-stream.test.ts` (text, tool use, thinking, usage, stop reasons, ping/unknown); `anthropic.test.ts` › stream; `anthropic.int.test.ts` › real SSE with `[DONE]` | ✅ |
| AC-11 | `inbound-stream.test.ts` › synthesised order and native forwarding; `messages.test.ts` › both paths; contract (Node, Python) › stream + `finalMessage` / `get_final_message` | ✅ |
| AC-12 | `outbound-stream.test.ts` › thinking emits nothing, `error` before/after content; `anthropic.test.ts` › pre-stream status and first-read error; `messages.test.ts` and `anthropic.int.test.ts` › mid-stream error event per route | ✅ |
| AC-13 | `upstream-errors.test.ts` (status and event tables, retryable flags, retry-after, no 5xx bodies); `anthropic.test.ts` › request-id span attribute; `anthropic.int.test.ts` › 429/529/500 | ✅ |
| AC-14 | `inbound-errors.test.ts`; `messages.test.ts` › 400/401/403/404/429/502 and invalid JSON in the Anthropic shape with `request_id` = `request-id` = `x-switchyard-request-id`; chat errors keep the OpenAI shape | ✅ |
| AC-15 | Fixtures in `test/fixtures/anthropic/`; `anthropic.int.test.ts` against the in-process fake server; `anthropic-live.contract.test.ts` skipped with a message unless `ANTHROPIC_API_KEY` and `SWITCHYARD_LIVE_ANTHROPIC=1` | ✅ |
| AC-16 | `anthropic-sdk.contract.test.ts` (TS SDK 0.129.0) and `test_anthropic_sdk.py` (Python SDK 1.9.0): create, stream, tool round trip and typed errors on mock and on the fake server; `openai-sdk.contract.test.ts` › chat, stream and tools routed to the fake Anthropic server | ✅ |

PII on `/v1/messages` (ADR-0016, spec 010): `messages-usage.test.ts` › cross-family mask + restore, same-family masked text written into the client blocks (system, text, tool_use input, tool_result) with thinking untouched and the message restored, `masked-unrestored` streams, `block` → Anthropic-shaped `400 pii_detected` with one `rejected` event and no upstream call, PII `off` keeps the body byte for byte.

Runs after the rebase: `pnpm verify` green (868 unit tests, coverage gate) · `anthropic.int.test.ts` + `upstream-http.int.test.ts` 20 passed (Docker lock; the full `pnpm test:int`, 44 passed, ran before the rebase) · `pnpm test:contract` 33 passed, 3 live skipped · `pnpm test:contract:py` 22 passed. Compose smoke not run locally (CI covers it).

Notes:
- The thinking open question was not checked live (no paid key in this run); the opt-in live test includes the OpenAI-surface tool loop that answers it.
- The two timing-sensitive reconciliation tests seen earlier are fixed on main by PR #11 (frozen limiter clock), kept as merged.
