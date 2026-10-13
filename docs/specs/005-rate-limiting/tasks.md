# Tasks 005: Rate limiting (requests and tokens per minute)

- **Status:** Approved (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-005]`. `pnpm verify` exit code checked after each.

- [x] **T1. Config: `limits` and `server.trustProxy`**
  - ACs: AC-1, AC-10, AC-11
  - Test: `schema.test.ts` › defaults (`completionReserveTokens` 512, `onRedisError` open, `authFailuresPerMinutePerIp` 30, empty `defaults`), validation; example config has `defaults` 60 / 100000.

- [x] **T2. Limits in the data model**
  - ACs: AC-1, AC-2
  - Do: migration (`rpm`/`tpm` + checks), core types (`Limits`, `AuthRecord`, principal limits), `findKeyByHash` joined with the team, `updateKeyLimits`/`updateTeamLimits`, memory store, `AuthCache.invalidateTeam`.
  - Test: `db.int.test.ts` › columns, join, updates, check constraint; `cache.test.ts` › `invalidateTeam`; existing auth tests adapted.

- [x] **T3. Token estimation and bucket plan**
  - ACs: AC-5
  - Test: `test/unit/ratelimit/estimate.test.ts`, `plan.test.ts` › chat/embeddings estimates, allowance precedence, effective limits (own → defaults; team own only), oversized request detection.

- [x] **T4. Header formatting**
  - ACs: AC-7
  - Test: `test/unit/ratelimit/headers.test.ts` › duration format, most-restrictive selection, omission when unlimited, `retry-after` ≥ 1.

- [x] **T5. `RateLimiter` port and `MemoryRateLimiter`**
  - ACs: AC-3, AC-4, AC-6
  - Test: `test/unit/ratelimit/memory-limiter.test.ts` › all-or-nothing, refill with a fake clock, adjust (refund capped at capacity, charge below zero), peek.

- [x] **T6. `RedisRateLimiter` with Lua**
  - ACs: AC-13
  - Test: `test/integration/ratelimit.int.test.ts` › same scenarios as T5 on real Redis, key expiry, parity with the memory limiter.

- [x] **T7. Admission service**
  - ACs: AC-3, AC-5, AC-6, AC-10, AC-12
  - Test: `test/unit/ratelimit/admission.test.ts` › admit/reject per scope and kind, reconcile rules, fail-open (metric, throttled warning) and fail-closed (503), span attributes, rejection counter.

- [x] **T8. Wire into chat and embeddings routes**
  - ACs: AC-3, AC-5, AC-6, AC-7
  - Test: `test/unit/proxy/ratelimit-routes.test.ts` › 429 before any provider call, headers on 200/429, 400 for oversized requests, refund on upstream failure, reconcile with usage.

- [x] **T9. Streaming reconciliation**
  - ACs: AC-6
  - Test: `stream.test.ts` › reconcile on completion, on mid-stream failure, on client disconnect (socket test).

- [x] **T10. Auth-failure limit per client address**
  - ACs: AC-11
  - Test: `authenticate.test.ts` › failures counted per IP, 429 without store lookups once exhausted, cached valid key still accepted, `trustProxy`.

- [x] **T11. Admin API: limits**
  - ACs: AC-2
  - Test: `admin.test.ts` › create key/team with limits, PATCH key/team, `null` clears, validation, cache invalidation (key and team).

- [x] **T12. Server wiring and multi-instance correctness**
  - ACs: AC-9, AC-10
  - Test: `ratelimit.int.test.ts` › two app instances on one Redis (exactly 10 of 50), Redis down open/closed through the HTTP API.

- [x] **T13. Contract suites**
  - ACs: AC-8
  - Test: Node and Python › key with `rpm: 1` → second call raises `RateLimitError`.

- [x] **T14. Smoke, docs and verification**
  - ACs: AC-14
  - Do: smoke steps; README (rate limits section, headers, config, admin PATCH, roadmap); backlog; verification table.

## Verification (2026-10-13)

| AC | Proven by | Result |
|---|---|---|
| AC-1 | `db.int.test.ts` › limit columns, join, check constraints; `schema.test.ts` › `limits` config defaults and validation | ✅ |
| AC-2 | `admin.test.ts` › create with limits, PATCH key/team, `null` clears, same-instance effect (cache invalidated by key and by team) | ✅ |
| AC-3 | `admission.test.ts` › 429 `type: requests`, nothing debited; `ratelimit-routes.test.ts` › provider not called | ✅ |
| AC-4 | `memory-limiter.test.ts` › continuous refill; `ratelimit.int.test.ts` › refill on real Redis | ✅ |
| AC-5 | `estimate.test.ts`, `plan.test.ts`; `admission.test.ts` › `type: tokens`; routes › 400 `request_too_large_for_limit` | ✅ |
| AC-6 | `admission.test.ts` › refund/charge/full refund; routes › reconcile with usage, refund on failure; `stream.test.ts` › end, mid-stream failure, failure before first chunk | ✅ |
| AC-7 | `headers.test.ts`; routes › headers on 200 and 429, omitted when unlimited; `retry-after` ≥ 1 | ✅ |
| AC-8 | Node SDK contract 13/13 and Python SDK contract 10/10 › `RateLimitError` with `retry-after` | ✅ |
| AC-9 | `ratelimit-http.int.test.ts` › two gateway instances, one Redis, 50 concurrent requests at `rpm: 10` → exactly 10 admitted | ✅ |
| AC-10 | `admission.test.ts` › fail-open metric + one warning per minute, fail-closed 503; `ratelimit-http.int.test.ts` › Redis unreachable over HTTP | ✅ |
| AC-11 | `authenticate.test.ts` › 429 without store lookups after 3 failures, missing/malformed counted, cached key and other addresses unaffected, `trustProxy` | ✅ (see note) |
| AC-12 | `admission.test.ts` › `switchyard_ratelimit_rejections_total{scope,kind}`; span attributes for reserved/actual tokens and rejection scope | ✅ |
| AC-13 | `ratelimit.int.test.ts` › Lua on real Redis: atomic multi-bucket, refill, floats, adjust, expiry, 10 of 50 under concurrency, parity with `MemoryRateLimiter`, timeout | ✅ |
| AC-14 | `pnpm test:smoke` (13/13 locally) › `rpm: 2` key gets 200, 200, 429 with `retry-after` and `x-ratelimit-remaining-requests: 0` | ✅ |

Deviations and fixes recorded here:
- AC-11 (as noted in the design): an address that used up its failures is refused for every key not already in the auth cache.
- **Bug found by AC-9's test and fixed:** the Redis client connected lazily (only via `/readyz`), so the limiter failed open until the first readiness probe. `server.ts` now connects Redis (up to 3 s) before listening.
- Unit test timeout raised to 15 s: on a loaded dev machine the first test of a file (which builds the app) occasionally exceeded 5 s.
