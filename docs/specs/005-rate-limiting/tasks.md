# Tasks 005: Rate limiting (requests and tokens per minute)

- **Status:** Approved (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-005]`. `pnpm verify` exit code checked after each.

- [ ] **T1. Config: `limits` and `server.trustProxy`**
  - ACs: AC-1, AC-10, AC-11
  - Test: `schema.test.ts` › defaults (`completionReserveTokens` 512, `onRedisError` open, `authFailuresPerMinutePerIp` 30, empty `defaults`), validation; example config has `defaults` 60 / 100000.

- [ ] **T2. Limits in the data model**
  - ACs: AC-1, AC-2
  - Do: migration (`rpm`/`tpm` + checks), core types (`Limits`, `AuthRecord`, principal limits), `findKeyByHash` joined with the team, `updateKeyLimits`/`updateTeamLimits`, memory store, `AuthCache.invalidateTeam`.
  - Test: `db.int.test.ts` › columns, join, updates, check constraint; `cache.test.ts` › `invalidateTeam`; existing auth tests adapted.

- [ ] **T3. Token estimation and bucket plan**
  - ACs: AC-5
  - Test: `test/unit/ratelimit/estimate.test.ts`, `plan.test.ts` › chat/embeddings estimates, allowance precedence, effective limits (own → defaults; team own only), oversized request detection.

- [ ] **T4. Header formatting**
  - ACs: AC-7
  - Test: `test/unit/ratelimit/headers.test.ts` › duration format, most-restrictive selection, omission when unlimited, `retry-after` ≥ 1.

- [ ] **T5. `RateLimiter` port and `MemoryRateLimiter`**
  - ACs: AC-3, AC-4, AC-6
  - Test: `test/unit/ratelimit/memory-limiter.test.ts` › all-or-nothing, refill with a fake clock, adjust (refund capped at capacity, charge below zero), peek.

- [ ] **T6. `RedisRateLimiter` with Lua**
  - ACs: AC-13
  - Test: `test/integration/ratelimit.int.test.ts` › same scenarios as T5 on real Redis, key expiry, parity with the memory limiter.

- [ ] **T7. Admission service**
  - ACs: AC-3, AC-5, AC-6, AC-10, AC-12
  - Test: `test/unit/ratelimit/admission.test.ts` › admit/reject per scope and kind, reconcile rules, fail-open (metric, throttled warning) and fail-closed (503), span attributes, rejection counter.

- [ ] **T8. Wire into chat and embeddings routes**
  - ACs: AC-3, AC-5, AC-6, AC-7
  - Test: `test/unit/proxy/ratelimit-routes.test.ts` › 429 before any provider call, headers on 200/429, 400 for oversized requests, refund on upstream failure, reconcile with usage.

- [ ] **T9. Streaming reconciliation**
  - ACs: AC-6
  - Test: `stream.test.ts` › reconcile on completion, on mid-stream failure, on client disconnect (socket test).

- [ ] **T10. Auth-failure limit per client address**
  - ACs: AC-11
  - Test: `authenticate.test.ts` › failures counted per IP, 429 without store lookups once exhausted, cached valid key still accepted, `trustProxy`.

- [ ] **T11. Admin API: limits**
  - ACs: AC-2
  - Test: `admin.test.ts` › create key/team with limits, PATCH key/team, `null` clears, validation, cache invalidation (key and team).

- [ ] **T12. Server wiring and multi-instance correctness**
  - ACs: AC-9, AC-10
  - Test: `ratelimit.int.test.ts` › two app instances on one Redis (exactly 10 of 50), Redis down open/closed through the HTTP API.

- [ ] **T13. Contract suites**
  - ACs: AC-8
  - Test: Node and Python › key with `rpm: 1` → second call raises `RateLimitError`.

- [ ] **T14. Smoke, docs and verification**
  - ACs: AC-14
  - Do: smoke steps; README (rate limits section, headers, config, admin PATCH, roadmap); backlog; verification table.
