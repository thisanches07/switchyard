# Tasks 008: Routing strategies, retries, circuit breakers and config hot reload

- **Status:** In progress
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-008]`. `pnpm verify` green after each. T7–T9 landed in one commit: the shared `route()`/`streamChat` contract changed for all three routes at once, so no smaller step compiled.

- [x] **T1. Config and core groundwork**
  - ACs: AC-1 (config keys), AC-2 (cost port), AC-9 (error)
  - Do: `src/core/pricing.ts` (shared with 007); `routing` config section; `noHealthyUpstream()`; `parseConfig(text, path, env)` in `load.ts`.
  - Test: `test/unit/config/schema.test.ts` › routing defaults and bounds; `test/unit/core/errors.test.ts` › no_healthy_upstream; `test/unit/config/load.test.ts` › parseConfig from text.
  - Files: `src/core/{pricing,errors}.ts`, `src/config/{schema,load}.ts`

- [x] **T2. Route planning and candidate ordering**
  - ACs: AC-1, AC-2
  - Test: `test/unit/routing/resolve.test.ts` › planRoute (alias, plain ref, unknown); `test/unit/routing/select.test.ts` › priority, lowest-cost (priced, unknown last, ties, no estimator), lowest-latency (cold first, EWMA order).
  - Files: `src/modules/routing/{resolve,select}.ts`

- [x] **T3. Backoff, Retry-After and failure classification**
  - ACs: AC-3, AC-4
  - Test: `test/unit/routing/backoff.test.ts` › full jitter bounds with fixed RNG, cap, Retry-After floor and cap, seconds and HTTP-date; `test/unit/routing/classify.test.ts` › status table, explicit flag wins, timeout, non-GatewayError.
  - Files: `src/modules/routing/{backoff,classify}.ts`

- [x] **T4. Circuit breaker and candidate health**
  - ACs: AC-8, AC-11, AC-12 (retention), AC-14 (gauge, logs)
  - Test: `test/unit/routing/breaker.test.ts` › threshold opens, open skips, half-open single probe, probe success closes, probe failure reopens, release, neutral outcomes; `test/unit/routing/health.test.ts` › EWMA, error window of 100, snapshot, retain on reload, gauge values, one log per transition.
  - Files: `src/modules/routing/{breaker,health,timers,telemetry}.ts`

- [x] **T5. Upstream Retry-After and reloadable timeouts**
  - ACs: AC-4, AC-7
  - Test: `test/unit/providers/openai-compatible.test.ts` › retry-after kept on 429 and 503; `test/integration/upstream-http.int.test.ts` › timeouts read from a getter per request.
  - Files: `src/modules/providers/openai-compatible.ts`, `src/infra/http/undici-client.ts`

- [x] **T6. Attempt loop**
  - ACs: AC-3, AC-4, AC-5, AC-7, AC-8, AC-9, AC-14
  - Test: `test/unit/proxy/attempts.test.ts` › fallback, wrap-around, maxAttempts total, non-retryable at once, backoff only on repeats with Retry-After floor, last error, client abort stops, total budget (504, backoff longer than budget), single half-open probe, no_healthy_upstream with retry-after; `test/unit/proxy/attempts-telemetry.test.ts` › attempt spans and counters, requests_total once per request.
  - Files: `src/modules/proxy/{attempts,telemetry}.ts`, `test/helpers/routing.ts` (manual clock, seeded RNG)

- [x] **T7. Chat and embeddings through the attempt loop**
  - ACs: AC-1, AC-2, AC-3, AC-5, AC-9, AC-10
  - Test: `test/unit/proxy/routing.test.ts` › allowed-models per candidate (403, filtered candidates), fallback headers and usage event attempts, 502/504/429 after all attempts, 503 no_healthy_upstream with attempts 0, lowest-cost with a fake estimator, embeddings fallback.
  - Files: `src/modules/proxy/routes.ts`, `src/modules/routing/models.ts`, `src/app.ts`, `test/helpers/app.ts`

- [x] **T8. Streaming through the attempt loop**
  - ACs: AC-6, AC-8, AC-10
  - Test: `test/unit/proxy/routing-stream.test.ts` › fallback before the first chunk gives one clean stream, mid-stream failure not retried and counted against the breaker, headers and usage event.
  - Files: `src/modules/proxy/{stream,routes}.ts`

- [x] **T9. `/v1/messages` through the attempt loop**
  - ACs: AC-1, AC-3, AC-6, AC-10
  - Test: `test/unit/proxy/messages-routing.test.ts` › fallback (stream and not), mixed-family alias with blockers drops non-anthropic candidates, Anthropic-shaped 503.
  - Files: `src/modules/proxy/messages.ts`

- [x] **T10. Config runtime and reload routine**
  - ACs: AC-12, AC-13
  - Test: `test/unit/config/runtime.test.ts` › unchanged hash, reload swaps snapshot, startup-fixed kept with restartRequired, provider instances reused, health retained/dropped, invalid YAML and schema keep the old snapshot and count failure, issues without values.
  - Files: `src/modules/config/runtime.ts`

- [x] **T11. Requests read the config snapshot**
  - ACs: AC-12
  - Test: `test/unit/proxy/reload-routes.test.ts` › new alias served after reload, in-flight request finishes with its config, reloaded limits and PII apply.
  - Files: `src/modules/proxy/routes.ts`, `src/modules/ratelimit/admission.ts`, `src/app.ts`

- [x] **T12. Admin health and reload endpoints**
  - ACs: AC-11, AC-12, AC-13
  - Test: `test/unit/admin/admin-routing.test.ts` › health view (states, EWMA, error rate, per-instance note), reload reloaded/unchanged, 400 invalid_config with issues, admin token required; `test/unit/app/openapi.test.ts` › paths.
  - Files: `src/modules/admin/routes.ts`, `src/modules/docs.ts`, `src/app.ts`

- [x] **T13. Poller, SIGHUP and server wiring**
  - ACs: AC-12
  - Test: `test/unit/config/watch.test.ts` › change detected and reloaded within 2.5 s of fake time, debounce, hotReload false skips, stop; SIGHUP installed only off Windows.
  - Files: `src/modules/config/watch.ts`, `src/server.ts`

- [ ] **T14. Chaos integration test**
  - ACs: AC-15
  - Test: `test/integration/routing-chaos.int.test.ts` › 1000 sequential requests (half streaming) over three `errorRate: 0.3` mocks, seed fixed: ≥ 990 successes, one completion id per stream, identical results on a second run.
  - Files: test only

- [ ] **T15. Compose smoke and example config**
  - ACs: AC-16
  - Test: `scripts/compose-smoke.ts` › `resilient` alias answers 200 with `x-switchyard-attempts: 2` and the second candidate (CI).
  - Files: `config/switchyard.example.yaml`, `scripts/compose-smoke.ts`

- [ ] **T16. Docs and verification**
  - ACs: all (DoD)
  - Do: README (features, request flow, model resolution, routing and resilience section, error table, roadmap), `docs/architecture.md`, `docs/threat-model.md`, verification table, spec status.
