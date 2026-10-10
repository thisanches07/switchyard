# Tasks 001: Project bootstrap

- **Status:** Approved (2026-10-09)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

Each task keeps `pnpm verify` green once T1 exists. Tests named here are the proof for the linked ACs. One commit per task, ending in `[spec-001]`.

## Tooling

- [x] **T1. Initialise the package and toolchain** (ADR-0013)
  - ACs: AC-8 (foundation), AC-10
  - Do: `package.json` (`"type": "module"`, `engines.node >=24`, `packageManager` pnpm pinned), scripts `dev`, `build`, `typecheck`, `lint`, `test`, `test:int`, `verify`; `tsconfig.json` (NodeNext, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `outDir: dist`); `tsconfig.build.json` excluding tests; `biome.json`; `vitest.config.ts` with `unit` and `integration` projects and v8 coverage.
  - Test: `test/unit/smoke.test.ts` › `toolchain runs` (trivial assertion so `pnpm verify` has something to run).
  - Files: `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, `biome.json`, `vitest.config.ts`, `test/unit/smoke.test.ts`

- [x] **T2. Repository hygiene files check**
  - ACs: AC-10
  - Do: add `.vscode/extensions.json` (Biome, EditorConfig); verify existing `.gitattributes`, `.editorconfig`, `.nvmrc`, `.gitignore`, `.env.example`, `LICENSE`, `config/switchyard.example.yaml`.
  - Test: `test/unit/repo/files.test.ts` › `required repository files exist`, `gitattributes enforces LF`.
  - Files: `.vscode/extensions.json`, `test/unit/repo/files.test.ts`

## Configuration

- [x] **T3. Config errors and formatting**
  - ACs: AC-6
  - Do: `ConfigError` holding `{ path, message }[]` + source label; `formatConfigError()` producing the multi-line message from design §4.3.
  - Test: `test/unit/config/errors.test.ts` › `formats issues with path and source`.
  - Files: `src/config/errors.ts`

- [x] **T4. Environment schema**
  - ACs: AC-6
  - Do: Zod schema from design §4.2 (`DATABASE_URL`, `REDIS_URL` required; defaults; `SHUTDOWN_TIMEOUT_MS < 10000`); `loadEnv(env)` returns typed env or throws `ConfigError`.
  - Test: `test/unit/config/env.test.ts` › `applies defaults`, `rejects missing DATABASE_URL`, `rejects invalid PORT`, `rejects SHUTDOWN_TIMEOUT_MS >= 10000`.
  - Files: `src/config/env.ts`

- [x] **T5. Config file schema**
  - ACs: AC-6, AC-2
  - Do: Zod schema for all top-level sections (design §4.3): `.strict()` top level, provider `type` enum, exactly one of `baseUrl`/`baseUrlEnv` for `openai-compatible`, alias candidates reference known providers, positive numbers, `similarityThreshold` in (0, 1].
  - Test: `test/unit/config/schema.test.ts` › `accepts config/switchyard.example.yaml`, `rejects unknown top-level key`, `rejects alias with unknown provider`, `rejects baseUrl and baseUrlEnv together`, `rejects similarityThreshold > 1`.
  - Files: `src/config/schema.ts`

- [x] **T6. Config loader**
  - ACs: AC-6, AC-2
  - Do: `loadConfig(path, env)`: read file, parse with `yaml` (syntax errors → `ConfigError` with line/column), validate, resolve `baseUrlEnv` from env (missing env var → `ConfigError`).
  - Test: `test/unit/config/load.test.ts` › `loads example config`, `reports YAML syntax error with position`, `reports missing file`, `resolves baseUrlEnv to host Ollama URL`, `fails when baseUrlEnv variable is unset`.
  - Files: `src/config/load.ts`, `test/fixtures/config/*.yaml`

## Observability foundations

- [x] **T7. Logger with trace correlation and redaction**
  - ACs: AC-7
  - Do: pino factory; `mixin` adds `trace_id`/`span_id` from the active span; redact `req.headers.authorization`, `req.headers["x-api-key"]`; accepts a destination stream for tests.
  - Test: `test/unit/telemetry/logger.test.ts` › `adds trace ids inside an active span`, `omits trace ids outside spans`, `redacts authorization header`.
  - Files: `src/infra/logger.ts`, `src/infra/telemetry/tracing.ts`

- [x] **T8. Telemetry registration**
  - ACs: AC-7
  - Do: `src/infra/telemetry/register.ts` starting `NodeSDK` (OTLP HTTP exporters for traces and metrics, HTTP/undici/pg/ioredis instrumentations, `service.name` from env), honouring `OTEL_SDK_DISABLED`; export `shutdownTelemetry()`.
  - Test: `test/unit/telemetry/register.test.ts` › `does not start when OTEL_SDK_DISABLED=true`, `shutdownTelemetry resolves when SDK not started`.
  - Files: `src/infra/telemetry/register.ts`

## HTTP app

- [x] **T9. App factory, 404 shape and health endpoint**
  - ACs: AC-4, AC-7
  - Do: `buildApp(deps)` with injected logger and checks; register `@fastify/otel`; OpenAI-shaped 404 handler; `GET /healthz`; health routes use log level `warn`.
  - Test: `test/unit/health/routes.test.ts` › `GET /healthz returns ok`, `unknown route returns OpenAI-style 404`.
  - Files: `src/app.ts`, `src/modules/health/routes.ts`, `src/core/health.ts`

- [x] **T10. Trace/log correlation proof**
  - ACs: AC-7
  - Do: wire the in-memory span exporter into a test helper.
  - Test: `test/unit/telemetry/correlation.test.ts` › `request span traceId equals log trace_id`.
  - Files: `test/helpers/telemetry.ts`, `test/unit/telemetry/correlation.test.ts`

- [x] **T11. Readiness aggregation**
  - ACs: AC-5
  - Do: `runReadiness(checks, timeoutMs)`: parallel checks with `AbortSignal.timeout`, statuses `ok | error | timeout`, `switchyard.readyz.check` spans, `switchyard_readiness_check_failures_total` counter; `GET /readyz` returning 200 or 503 per design §4.1.
  - Test: `test/unit/health/readiness.test.ts` › `all ok → ready`, `one failing → not_ready lists it`, `hanging check → timeout within budget`; `routes.test.ts` › `GET /readyz returns 503 with failing list`.
  - Files: `src/modules/health/readiness.ts`, `src/modules/health/routes.ts`

- [x] **T12. Postgres and Redis dependency checks**
  - ACs: AC-5
  - Do: `pg` Pool factory + `SELECT 1` check; `ioredis` factory (`lazyConnect`, bounded retries) + `PING` check; both honour the abort signal.
  - Test: `test/integration/readyz.int.test.ts` › `ready with real Postgres and Redis`, `503 listing redis after Redis container stops` (Testcontainers).
  - Files: `src/infra/db/postgres.ts`, `src/infra/redis/client.ts`, `test/integration/readyz.int.test.ts`

## Process lifecycle

- [x] **T13. Graceful shutdown**
  - ACs: AC-9
  - Do: `installShutdown({ app, closers, timeoutMs, exit })` per design §3.3 (close app, then closers in order, forced exit on timeout, second signal exits immediately); `exit` injectable for tests.
  - Test: `test/unit/lifecycle/shutdown.test.ts` › `closes app then closers in order`, `forces exit after timeout`, `second signal exits immediately`; `test/unit/lifecycle/shutdown.process.test.ts` › `exits within 10s on SIGTERM` (skipped on win32).
  - Files: `src/lifecycle/shutdown.ts`, test files above

- [x] **T14. Server entry point**
  - ACs: AC-6, AC-9
  - Do: `src/server.ts` `main()`: loadEnv → loadConfig → logger → clients → buildApp → listen → installShutdown; on `ConfigError` print formatted message to stderr and exit 1; listen errors exit 1.
  - Test: `test/unit/server/boot.test.ts` › `exits non-zero with readable error on invalid config`, `exits non-zero when DATABASE_URL is missing` (spawns the built server).
  - Files: `src/server.ts`, `test/unit/server/boot.test.ts`

## Containers and CI

- [x] **T15. Dockerfile**
  - ACs: AC-1
  - Do: multi-stage `node:24-bookworm-slim` per design §4.5; `.dockerignore`; non-root; `--import` telemetry preload.
  - Test: CI `compose-smoke` (T17) builds and runs it; local check `docker build .` succeeds.
  - Files: `Dockerfile`, `.dockerignore`

- [x] **T16. Docker Compose stack**
  - ACs: AC-1, AC-2, AC-3
  - Do: services and settings from design §4.4 with pinned tags, healthchecks, named volumes, `ollama` profile, `extra_hosts` for `host.docker.internal`.
  - Test: local `docker compose up -d --wait` then `curl /healthz` and `/readyz`; automated in T17.
  - Files: `docker-compose.yml`

- [x] **T17. CI workflow**
  - ACs: AC-8, AC-1, AC-3, AC-4, AC-5, AC-6
  - Do: `.github/workflows/ci.yml` with `verify`, `integration` and `compose-smoke` jobs (design §4.6): smoke asserts `/healthz` 200, `/readyz` 200, `--profile ollama config` lists `ollama`, broken config exits non-zero, `docker stats` total < 4 GB; `concurrency` group; `.github/dependabot.yml` for npm, docker and github-actions.
  - Test: the workflow itself; green on the first PR after the GitHub remote exists.
  - Files: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `scripts/compose-smoke.ts`, `scripts/lib/stack-memory.ts` (cross-platform smoke script, also runnable locally with `node scripts/compose-smoke.ts`)

## Docs

- [x] **T18. README and docs update**
  - ACs: all (Definition of done)
  - Do: README "Development" section (prereqs table from spec, Docker Desktop ≥ 6 GB to WSL2, `pnpm verify`, how to see a trace in Grafana); mark spec 001 `Done` in `docs/specs/README.md`; tick roadmap if applicable.
  - Test: `pnpm verify` green; `/verify 001` AC → test table complete.
  - Files: `README.md`, `docs/specs/README.md`, `docs/specs/001-bootstrap/spec.md`

## Verification (2026-10-10)

| AC | Proven by | Result |
|---|---|---|
| AC-1 | `scripts/compose-smoke.ts` › stack starts (`docker compose up --wait`) | ✅ local (Windows, Docker Desktop) |
| AC-2 | `test/unit/config/load.test.ts` › resolves baseUrlEnv to host Ollama URL; smoke › ollama profile adds the ollama service | ✅ |
| AC-3 | smoke › stack memory at idle stays under 4 GiB (measured 0.81–0.97 GiB, 5 containers) | ✅ local |
| AC-4 | `test/unit/health/routes.test.ts` › GET /healthz returns ok; smoke › GET /healthz | ✅ |
| AC-5 | `test/unit/health/readiness.test.ts`; `routes.test.ts` › GET /readyz returns 503 with failing list; `test/integration/readyz.int.test.ts` (Testcontainers) | ✅ |
| AC-6 | `test/unit/config/{env,schema,load}.test.ts`; `test/unit/server/boot.test.ts`; smoke › invalid config exits non-zero | ✅ |
| AC-7 | `test/unit/telemetry/correlation.test.ts`; `logger.test.ts`; traces seen in Tempo for `switchyard-gateway` (manual) | ✅ |
| AC-8 | `.github/workflows/ci.yml` (`verify`, `integration`, `compose-smoke`) | ⏳ pending: no GitHub remote yet. `pnpm verify` passed inside a `node:24.21.0-bookworm-slim` container (61/61 tests) as a stand-in |
| AC-9 | `test/unit/lifecycle/shutdown.test.ts`; `shutdown.process.test.ts` (Linux container: 664 ms); smoke › gateway exits 0 within 10 s on SIGTERM (≈ 0.7 s) | ✅ |
| AC-10 | `test/unit/repo/files.test.ts` | ✅ |

Deviations from design, recorded here:
- Health routes use route log level `warn` instead of `debug` (Fastify route levels can only filter, not demote).
- `PORT` accepts `0` (ephemeral port) for tests.
- The memory check lives in `scripts/compose-smoke.ts` + `scripts/lib/stack-memory.ts` (Node, cross-platform) instead of a separate `.mjs` script.
- The smoke test triggers the invalid-config path by clearing `OLLAMA_BASE_URL` rather than bind-mounting a fixture (Windows bind mounts of the fixture dropped the Docker Desktop connection).
