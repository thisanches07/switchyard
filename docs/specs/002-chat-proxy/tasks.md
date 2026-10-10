# Tasks 002: Chat proxy (non-streaming)

- **Status:** Approved (2026-10-10)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-002]`. `pnpm verify` green after each.

- [x] **T1. Coverage gate**
  - ACs: AC-12
  - Do: coverage thresholds (lines ≥ 80%) for `src/core/**` and `src/modules/**` in `vitest.config.ts`; `verify` runs `test:coverage` instead of `test`.
  - Test: `pnpm verify` fails if the threshold is lowered below current coverage (checked once manually), passes now.
  - Files: `vitest.config.ts`, `package.json`

- [x] **T2. Canonical types and gateway errors**
  - ACs: AC-3, AC-4, AC-6 (foundation)
  - Do: `src/core/chat.ts`, `src/core/provider.ts`; `GatewayError` + helpers in `src/core/errors.ts`.
  - Test: `test/unit/core/errors.test.ts` › helpers produce status/type/code from design §4.2; `toBody()` returns OpenAI shape.
  - Files: `src/core/{chat,provider,errors}.ts`

- [x] **T3. Model resolution and model list**
  - ACs: AC-1, AC-2, AC-3, AC-8
  - Do: `resolveModel` and `listModels` (pure).
  - Test: `test/unit/routing/resolve.test.ts` › alias → first candidate, provider/model with slashes, unknown provider, unknown alias; `test/unit/routing/models.test.ts` › aliases first, distinct candidates, owned_by.
  - Files: `src/modules/routing/{resolve,models}.ts`

- [x] **T4. Mock provider**
  - ACs: AC-10
  - Do: adapter per design §4.4 with injectable `random` and abortable latency.
  - Test: `test/unit/providers/mock.test.ts` › deterministic body and usage, no content echo, latency honoured, `error-500`/`error-429`, `errorRate` with fixed random, abort.
  - Files: `src/modules/providers/mock.ts`

- [x] **T5. OpenAI-compatible adapter and HttpClient port**
  - ACs: AC-5, AC-6
  - Do: `HttpClient` port in core; adapter mapping status/errors per §4.2; bearer key only when configured.
  - Test: `test/unit/providers/openai-compatible.test.ts` (fake client) › URL and body with resolved model, unknown fields passed through, auth header present/absent, 4xx passthrough with upstream error fields, 5xx→502 without upstream body, network→502, timeout→504, non-JSON 200→502, usage/model extracted.
  - Files: `src/core/provider.ts`, `src/modules/providers/openai-compatible.ts`

- [ ] **T6. Provider registry**
  - ACs: AC-5 (keys), spec non-goal (anthropic 501)
  - Do: `createProviderRegistry(config, env, deps)`; anthropic → not-implemented adapter; missing key → adapter that fails 503 `provider_not_configured`.
  - Test: `test/unit/providers/registry.test.ts` › builds one adapter per provider, anthropic → 501, missing key → 503 naming the variable (no value leaked).
  - Files: `src/modules/providers/{registry,not-implemented}.ts`

- [ ] **T7. undici HTTP client**
  - ACs: AC-6
  - Do: `createUndiciClient(timeouts)` with shared `Agent`; normalise errors to `UpstreamNetworkError` / `UpstreamTimeoutError`.
  - Test: `test/integration/upstream-http.int.test.ts` › local `node:http` server: JSON 200, 500 status returned, headers timeout → timeout error, refused port → network error, abort signal honoured.
  - Files: `src/infra/http/undici-client.ts`

- [ ] **T8. App wiring: error handler, request id header, deps**
  - ACs: AC-4, AC-7
  - Do: `AppDeps` from design §3; `genReqId` → `req_<uuid>`; `onSend` adds `x-switchyard-request-id`; `setErrorHandler` maps `GatewayError`, Fastify body errors (invalid JSON, 413, 415) and unknown errors per §4.2; update test helper and `server.ts`.
  - Test: `test/unit/app/errors.test.ts` › invalid JSON → 400 invalid_json, oversized body → 413, unexpected error → 500 generic message; `health/routes.test.ts` › request id header present.
  - Files: `src/app.ts`, `src/server.ts`, `test/helpers/app.ts`

- [ ] **T9. Chat and models routes**
  - ACs: AC-1, AC-2, AC-3, AC-4, AC-7, AC-8
  - Do: `schema.ts` + `routes.ts`; replace `model`, call adapter with request abort signal, set headers, return body.
  - Test: `test/unit/proxy/chat.test.ts` › alias success, direct provider/model, unknown model 404 (provider not called), missing messages 400 naming field, stream true 400, headers on success and on upstream error, GET /v1/models.
  - Files: `src/modules/proxy/{schema,routes}.ts`, `src/app.ts`

- [ ] **T10. Upstream span and metrics**
  - ACs: AC-9
  - Do: `telemetry.ts` (span + counter + histogram), used by routes; warn log on 5xx/timeout without content.
  - Test: `test/unit/proxy/telemetry.test.ts` › span name/kind/gen_ai attributes and usage; error status on failure; no attribute contains message content; counter and histogram recorded with labels (in-memory metric reader).
  - Files: `src/modules/proxy/telemetry.ts`, `src/modules/proxy/routes.ts`, `test/helpers/metrics.ts`

- [ ] **T11. Contract tests with the official OpenAI SDK**
  - ACs: AC-11
  - Do: `contract` Vitest project and `pnpm test:contract`; gateway listening on port 0 with mock provider; Ollama case skipped when `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`) is unreachable; CI step in `verify` job.
  - Test: `test/contract/openai-sdk.contract.test.ts` › chat via alias on mock, `models.list()` includes aliases, SDK surfaces 404 as `NotFoundError`, chat on Ollama (conditional).
  - Files: `vitest.config.ts`, `package.json`, `.github/workflows/ci.yml`, `test/contract/*`

- [ ] **T12. Local-only port binding, docs and verification**
  - ACs: spec non-goal (unauthenticated until 004), DoD
  - Do: compose ports bound to `127.0.0.1`; README: try-it section with curl and SDK against `local`/`mock`, unauthenticated warning; backlog status; verification table.
  - Test: `pnpm verify`, `pnpm test:int`, `pnpm test:contract`, `pnpm test:smoke` green.
  - Files: `docker-compose.yml`, `README.md`, `docs/specs/README.md`, this file
