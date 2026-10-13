# Tasks 004: Virtual API keys, teams and the admin API

- **Status:** Approved (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-004]`. `pnpm verify` green after each (exit code checked, not grepped).

- [x] **T1. Environment: `KEY_PEPPER`, `ADMIN_TOKEN`, `MIGRATE_ON_BOOT`**
  - ACs: AC-9
  - Test: `env.test.ts` › pepper required and ≥ 32 chars, admin token optional and ≥ 16 chars, `MIGRATE_ON_BOOT` parsing; `.env.example` and test helpers updated.

- [x] **T2. Key primitives**
  - ACs: AC-2
  - Test: `test/unit/auth/keys.test.ts` › `sk-sy-` + ≥ 43 base62 chars, unique, `hashKey` deterministic and pepper-dependent, prefix, `parseBearer` variants.

- [x] **T3. Auth cache**
  - ACs: AC-6
  - Test: `test/unit/auth/cache.test.ts` › TTL expiry (fake timers), LRU eviction, `invalidateKey`.

- [x] **T4. Core auth types, errors, in-memory store and model rules**
  - ACs: AC-4, AC-5, AC-7
  - Test: `core/errors.test.ts` › new errors; `test/unit/auth/models.test.ts` › null/empty list allows all, exact match on alias or ref, `provider/*`; memory store behaviour (duplicate team → 409).

- [x] **T5. Drizzle schema, migrations and `DrizzleKeyStore`**
  - ACs: AC-1, AC-7
  - Test: `test/integration/db.int.test.ts` (Testcontainers) › migrate twice, team/key CRUD, duplicate team 409, find by hash, revoke.
  - Files: `src/infra/db/*`, `drizzle/`, `drizzle.config.ts`, `scripts/db-migrate.ts`.

- [x] **T6. Authentication hook on `/v1/*`**
  - ACs: AC-3, AC-4, AC-5
  - Test: `test/unit/auth/authenticate.test.ts` › each 401 reason (provider not called), valid key, expiry on cache hit, 403 `model_not_allowed`, `/v1/models` filtered, health open; existing proxy tests use a test key.

- [x] **T7. Team and key telemetry**
  - ACs: AC-3
  - Test: `telemetry.test.ts` › `team` label, span attributes, `switchyard_auth_failures_total`.

- [x] **T8. Admin API**
  - ACs: AC-6, AC-7, AC-8
  - Test: `test/unit/admin/admin.test.ts` › all routes, 400/401/404/409, key shown once, revoke invalidates cache immediately, absent without `ADMIN_TOKEN`.

- [x] **T9. OpenAPI docs**
  - ACs: AC-10
  - Test: `test/unit/app/openapi.test.ts`; ADR-0014 compilers keep passthrough intact (existing proxy tests).

- [x] **T10. Server wiring and migrations at boot**
  - ACs: AC-1, AC-8
  - Do: `DrizzleKeyStore` in `server.ts`, `MIGRATE_ON_BOOT`, dev-only secret warning; Dockerfile copies `drizzle/`; Compose env defaults.
  - Test: `boot.test.ts` › starts with pepper; warning for dev-only secrets.

- [x] **T11. Contract suites with keys**
  - ACs: AC-11
  - Test: Node and Python suites create team + key via the admin API; bad key → `AuthenticationError`.

- [x] **T12. Smoke, docs and verification**
  - ACs: AC-12
  - Do: smoke steps (401, admin create, authenticated chat); README (quickstart with key creation, security note, admin API, `/docs`); backlog; verification table.

## Verification (2026-10-13)

| AC | Proven by | Result |
|---|---|---|
| AC-1 | `test/integration/db.int.test.ts` › migrations create tables, second run no-op; CI smoke › stack starts with `MIGRATE_ON_BOOT=true` | ✅ |
| AC-2 | `test/unit/auth/keys.test.ts`; `admin.test.ts` › key returned once, never listed; Postgres holds only prefix + 64-char hash (manual check) | ✅ |
| AC-3 | `authenticate.test.ts` › valid key; `telemetry.test.ts` › `team` label, `switchyard.team_id`/`key_id` on request and upstream spans | ✅ |
| AC-4 | `authenticate.test.ts` › missing, wrong scheme, non-Switchyard, unknown, revoked, expired (also when cached) → 401, provider never called; health open | ✅ |
| AC-5 | `test/unit/auth/models.test.ts`; `authenticate.test.ts` › 403, aliases/refs/wildcards, embeddings, filtered `/v1/models` | ✅ |
| AC-6 | `test/unit/auth/cache.test.ts`; `authenticate.test.ts` › one store lookup for three requests; `admin.test.ts` › revoked key rejected immediately although cached | ✅ |
| AC-7 | `test/unit/admin/admin.test.ts` (all routes, 400/404/409, no secrets in listings); `db.int.test.ts` › Drizzle store incl. duplicate team → 409 | ✅ |
| AC-8 | `admin.test.ts` › 401 for missing/wrong token, 404 when `ADMIN_TOKEN` is unset; `boot.test.ts` › warning at boot | ✅ |
| AC-9 | `env.test.ts` › missing or short `KEY_PEPPER` refused | ✅ |
| AC-10 | `test/unit/app/openapi.test.ts` › `/docs/json` paths and security schemes, `/docs/` HTML, passthrough intact | ✅ |
| AC-11 | Node SDK contract 12/12 and Python SDK contract 9/9 with keys issued through the admin API; bad key → `AuthenticationError` | ✅ |
| AC-12 | CI `compose-smoke` on PR #5: 401 without key, admin creates team + key, chat/stream/embeddings with that key (12/12 steps) | ✅ (CI) |

Also run: an end-to-end check with the gateway running natively against the Compose Postgres (migrations at boot, admin flow, 401/200/403/401-after-revoke, `/docs`).

Deviations and notes recorded here:
- The Compose smoke test could not run on the dev machine: Docker Desktop (Hyper-V backend, 2 GB VM, another project's containers running) stopped starting containers. AC-12 is proven by the CI run instead.
- The demo SVG in the README was re-recorded with an authenticated request (real values, 2026-10-13).
- ADR-0014 stays **Proposed** until reviewed.
