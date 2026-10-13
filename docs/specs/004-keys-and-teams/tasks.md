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

- [ ] **T5. Drizzle schema, migrations and `DrizzleKeyStore`**
  - ACs: AC-1, AC-7
  - Test: `test/integration/db.int.test.ts` (Testcontainers) › migrate twice, team/key CRUD, duplicate team 409, find by hash, revoke.
  - Files: `src/infra/db/*`, `drizzle/`, `drizzle.config.ts`, `scripts/db-migrate.ts`.

- [ ] **T6. Authentication hook on `/v1/*`**
  - ACs: AC-3, AC-4, AC-5
  - Test: `test/unit/auth/authenticate.test.ts` › each 401 reason (provider not called), valid key, expiry on cache hit, 403 `model_not_allowed`, `/v1/models` filtered, health open; existing proxy tests use a test key.

- [ ] **T7. Team and key telemetry**
  - ACs: AC-3
  - Test: `telemetry.test.ts` › `team` label, span attributes, `switchyard_auth_failures_total`.

- [ ] **T8. Admin API**
  - ACs: AC-6, AC-7, AC-8
  - Test: `test/unit/admin/admin.test.ts` › all routes, 400/401/404/409, key shown once, revoke invalidates cache immediately, absent without `ADMIN_TOKEN`.

- [ ] **T9. OpenAPI docs**
  - ACs: AC-10
  - Test: `test/unit/app/openapi.test.ts`; ADR-0014 compilers keep passthrough intact (existing proxy tests).

- [ ] **T10. Server wiring and migrations at boot**
  - ACs: AC-1, AC-8
  - Do: `DrizzleKeyStore` in `server.ts`, `MIGRATE_ON_BOOT`, dev-only secret warning; Dockerfile copies `drizzle/`; Compose env defaults.
  - Test: `boot.test.ts` › starts with pepper; warning for dev-only secrets.

- [ ] **T11. Contract suites with keys**
  - ACs: AC-11
  - Test: Node and Python suites create team + key via the admin API; bad key → `AuthenticationError`.

- [ ] **T12. Smoke, docs and verification**
  - ACs: AC-12
  - Do: smoke steps (401, admin create, authenticated chat); README (quickstart with key creation, security note, admin API, `/docs`); backlog; verification table.
