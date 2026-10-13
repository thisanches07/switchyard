# Tasks 007: Cost accounting and monthly budgets

- **Status:** Approved (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-007]`. `pnpm verify` green after each (exit code checked); `pnpm test:int` (only the touched files) for tasks that touch infra.

- [x] **T1. Pricing port and exact decimals**
  - ACs: AC-2
  - Do: `src/core/pricing.ts` (`TokenCounts`, `CostEstimator`, shared with spec 008); `src/modules/pricing/decimal.ts`.
  - Test: `test/unit/pricing/decimal.test.ts` › parse (plain, numbers, exponents, invalid), add/sub/mulInt/compare, half-up rounding, toFixed and normalize never emit an exponent.

- [x] **T2. Price table, loader and boot wiring**
  - ACs: AC-1, AC-2
  - Do: `src/modules/pricing/{table,load}.ts`; `AppDeps.costEstimator`; `server.ts` loads `pricingFile` (exit on error) and logs the unknown-price warning.
  - Test: `test/unit/pricing/table.test.ts` › exact > most specific pattern > file order, `*` spans `/`, cost formula with cached input (with and without `cachedInput`), zero-count prices not needed, `TODO`/missing → `null`, 10-place half-up, `estimateUsd`, `unknownPriceCandidates`; `test/unit/pricing/load.test.ts` › repo `config/pricing.yaml` loads, unknown field/negative/other string rejected naming the entry, missing file; `boot.test.ts` › invalid pricing file exits 1 naming it.

- [x] **T3. Cost on usage events, `x-switchyard-cost-usd` and cost metrics**
  - ACs: AC-2, AC-3, AC-13
  - Do: outcome hook `price` dep and `tracker.event`; proxy `onSend` header; charger recorder (metrics only for now) composed with `fanOut` in `buildApp`.
  - Test: `test/unit/usage/outcome.test.ts` › cost from price, `"0"` without upstream call, contribution wins, price errors → `null`; `test/unit/proxy/cost.test.ts` › header on chat/embeddings/messages equals event `costUsd`, absent on streams and unknown prices, estimated tokens priced, `switchyard_cost_usd_total` and `switchyard_cost_unknown_requests_total`.

- [x] **T4. Budget columns in the data model (migration `0004_budgets`)**
  - ACs: AC-4
  - Do: schema + `pnpm db:generate --name budgets` (+ checks); `Team`/`ApiKeyRecord`/`KeyPatch`/`TeamPatch`/`Principal.budget`; Drizzle and memory stores (`getKey`); `authenticate` fills `principal.budget`.
  - Test: `db.int.test.ts` › columns, defaults, round trip, checks; `memory-store.test.ts` › same semantics; `authenticate.test.ts` › principal budget.

- [x] **T5. Admin API: `monthlyBudgetUsd` and `softLimitPct`**
  - ACs: AC-4
  - Do: create/PATCH bodies, decimal validation, normalized views, cache invalidation, OpenAPI bodies, `createKeyViaAdmin` option.
  - Test: `test/unit/admin/admin-budgets.test.ts` › number and string accepted and normalized, `null` clears, negative/5 places/too large/garbage → 400, PATCH with one field, team `softLimitPct` 1–100, listings, auth cache invalidated.

- [x] **T6. Periods and budget counters (memory and Redis)**
  - ACs: AC-5, AC-10
  - Do: `src/core/budget.ts`; `src/modules/budgets/period.ts`; `src/infra/memory/budget-counters.ts`; `src/infra/redis/budget-counters.ts`.
  - Test: `test/unit/budgets/period.test.ts` › month boundaries incl. December and leap years, instant at 00:00:00Z; `test/unit/budgets/memory-counters.test.ts` › charge, read, raise never lowers, expiry; `test/integration/budget-counters.int.test.ts` › same on real Redis, PEXPIREAT set, timeout.

- [ ] **T7. Budget check before rate limiting**
  - ACs: AC-6, AC-8, AC-9, AC-11, AC-13
  - Do: `budgets` config key; `budgetExceeded`/`budgetUnavailable` errors; `src/modules/budgets/{check,telemetry}.ts`; wired into `admit()`; `AppDeps.budgetCounters`.
  - Test: `test/unit/budgets/check.test.ts` › `evaluateBudgets` (reject at equality, lowest remaining, key wins ties, soft thresholds, headers), Redis error closed → 503 / open → admit + metric + one warning per minute, no read without budgets, span attributes, warning once per scope/id/period; `test/unit/proxy/budget-routes.test.ts` › 429 shape and headers, no provider call, no rate-limit debit, no usage event, budget `0` blocks, headers on 200 and on the stream, `/v1/messages` Anthropic shape, change applies immediately after PATCH.

- [ ] **T8. Charging counters at the outcome hook and the used-ratio gauge**
  - ACs: AC-10, AC-11, AC-13
  - Do: charger charges key and team counters for known costs (period of `occurredAt`), charge failures counted, `switchyard_budget_used_ratio`.
  - Test: `test/unit/budgets/charge.test.ts` › charged for every key/team, unknown and zero not charged, failure → metric and response unaffected, gauge set/cleared/new-period reset; `budget-routes.test.ts` › second request rejected after the first spent the budget.

- [ ] **T9. Budget status routes**
  - ACs: AC-12
  - Do: `BudgetStore` port; `src/infra/db/budget-store.ts`; `src/modules/budgets/status.ts`; admin routes; OpenAPI.
  - Test: `test/unit/admin/admin-budget-status.test.ts` › key and team shapes, no budget → nulls, soft/hard flags, Redis down → `source: "postgres"`, 404, 503 without store, admin token; `openapi.test.ts` › routes listed; `test/integration/budget-store.int.test.ts` › period sums by key and team, unknown counts, budgets listed.

- [ ] **T10. Worker reconciliation**
  - ACs: AC-10, AC-13
  - Do: `src/modules/budgets/reconcile.ts`; worker env `REDIS_URL`, `loadWorkerConfig`; `src/worker.ts` starts/stops it.
  - Test: `test/unit/budgets/reconcile.test.ts` › raises lower counters, never lowers, current period only, gauge replaced, failures logged and retried, stop; `env.test.ts`, `load.test.ts`.

- [ ] **T11. Integration: hard limit, overshoot bound, reconciliation, Redis policies**
  - ACs: AC-6, AC-7, AC-10, AC-11, AC-14
  - Test: `test/integration/budgets.int.test.ts` › real Redis + Postgres: hard limit, overshoot bound under concurrent waves, Redis flush → enforcement restored by one reconciliation, dead Redis closed → 503 for budgeted / 200 for unbudgeted, open → 200 + metric.

- [ ] **T12. SDK contract tests**
  - ACs: AC-14
  - Test: `openai-sdk.contract.test.ts` › `RateLimitError` with status 429 and code `budget_exceeded`, not retried with default `maxRetries`; `test/contract/python/test_openai_sdk.py` › same with the Python SDK.

- [ ] **T13. Compose stack and smoke**
  - ACs: AC-14
  - Do: worker `REDIS_URL`; smoke steps.
  - Test: `scripts/compose-smoke.ts` › mock request has `x-switchyard-cost-usd`; key `monthlyBudgetUsd: 0` → `429 budget_exceeded`.

- [ ] **T14. Docs and verification**
  - ACs: AC-7 (guide), all
  - Do: README budgets section, `docs/budgets.md` (overshoot bound), threat model *denial of wallet* row, architecture, example config, verification table, spec status.
