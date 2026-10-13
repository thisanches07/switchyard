# Tasks 006: Usage event pipeline

- **Status:** Approved (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-006]`. `pnpm verify` exit code checked after each; `pnpm test:int` (only the touched files) for tasks that touch infra.

- [x] **T1. Config: `usage` section and `KAFKA_BROKERS`**
  - ACs: AC-4
  - Do: `usage` schema with defaults; `KAFKA_BROKERS` (optional, parsed list) in the gateway env; `loadWorkerEnv`; `loadUsageConfig` (reads only the `usage` section); example config.
  - Test: `schema.test.ts` › `usage` defaults and validation; `env.test.ts` › `KAFKA_BROKERS` parsing, worker env requires `DATABASE_URL` and `KAFKA_BROKERS`; `load.test.ts` › `loadUsageConfig` ignores provider env.

- [x] **T2. `UsageEvent` v1 schema, UUIDv7 and ports in core**
  - ACs: AC-1, AC-2
  - Do: `src/core/usage.ts` (schema, types, `OutcomeRecorder`, `MessageProducer`, `UsageStore`, `UsageReader`), `src/core/uuid.ts`.
  - Test: `test/unit/usage/schema.test.ts` › accepts a full event; rejects unknown fields, `schemaVersion: 2`, a v4 id, negative tokens, `costUsd` with exponent or sign; `uuid.test.ts` › version/variant bits, time ordering.

- [ ] **T3. Outcome tracker**
  - ACs: AC-3
  - Do: `src/modules/usage/outcome.ts` (`createOutcomeHook`, tracker, request augmentation), `recorders.ts` (`noopRecorder`, `fanOut`).
  - Test: `test/unit/usage/outcome.test.ts` › success, fail (GatewayError and unknown error), failMidstream, clientClosed (200/499), reject (provider null, attempts 0, tokens 0), `set()` contributions, exactly one event when two terminal calls race, recorder errors swallowed.

- [ ] **T4. Wire the hook into chat, embeddings and streams**
  - ACs: AC-2, AC-3
  - Do: `AppDeps.usageRecorder`; `admit()` begins the tracker; `settle()` and `streamChat` end it; `onResponse` safety net; provider-reported `cachedInputTokens` (`usage.prompt_tokens_details.cached_tokens`).
  - Test: `test/unit/usage/routes-outcome.test.ts` › one event per case (chat/embeddings, stream/non-stream, success/upstream error/mid-stream/disconnect), none for 401/404/429, cached tokens, marker absent from the event JSON; `openai-compatible.test.ts`/`usage.test.ts` › cached tokens parsed.

- [ ] **T5. Usage publisher (bounded buffer)**
  - ACs: AC-1, AC-5, AC-6, AC-7, AC-12
  - Do: `src/modules/usage/publisher.ts`, `telemetry.ts`.
  - Test: `test/unit/usage/publisher.test.ts` › validates before buffering, disabled never sends, record is synchronous, key = team id, periodic flush, failed send kept and retried, buffer full → drop + metric + one warning per minute, close flushes and counts leftovers as `shutdown`, gauge and published counter.

- [ ] **T6. Kafka producer and gateway wiring**
  - ACs: AC-4, AC-5, AC-6, AC-7
  - Do: `src/infra/kafka/{client,producer}.ts`, `server.ts` (required `KAFKA_BROKERS`, publisher start, closer with deadline), `installShutdown` passes `{ deadlineAt }`, `@testcontainers/redpanda`.
  - Test: `boot.test.ts` › missing `KAFKA_BROKERS` exits naming it, starts with Kafka unreachable; `shutdown.test.ts` › closers receive the deadline; `test/integration/usage-producer.int.test.ts` › events published to Redpanda with the team id as key.

- [ ] **T7. Migration `0002_usage_events` and the usage store**
  - ACs: AC-8, AC-9, AC-10
  - Do: Drizzle tables, generated migration, `DrizzleUsageStore.insertEvents`.
  - Test: `test/integration/usage-store.int.test.ts` › row with every field (exact `cost_usd`), daily aggregate, same event twice → one row counted once, unknown costs counted apart, model = provider/servedModel or requested model; `db.int.test.ts` › table list.

- [ ] **T8. Worker batch processing**
  - ACs: AC-1, AC-9, AC-10, AC-12
  - Do: `src/modules/usage/consume.ts` (+ worker metric and span).
  - Test: `test/unit/usage/consume.test.ts` › valid stored, duplicates counted, invalid JSON and schema failures → DLQ with original bytes and headers, Postgres error → throws before any DLQ, in-batch duplicate ids, `switchyard_usage_worker_events_total`, `switchyard.usage.consume` span without content.

- [ ] **T9. Worker process and consumer**
  - ACs: AC-8, AC-9, AC-10, AC-13
  - Do: `src/infra/kafka/{consumer,topics}.ts`, `src/worker.ts`, `pnpm dev:worker`.
  - Test: `test/integration/usage-pipeline.int.test.ts` › topics created, publish → row + aggregate, same event twice → counted once, malformed → DLQ while the next valid one is stored, worker restart mid-stream → no loss and no double count.

- [ ] **T10. `GET /admin/usage`**
  - ACs: AC-11
  - Do: `src/modules/usage/report.ts`, admin route, OpenAPI docs, `DrizzleUsageStore.summarize`.
  - Test: `test/unit/usage/report.test.ts` › defaults, validation (dates, ids, order, 366 days, groupBy), decimal normalisation; `test/unit/admin/admin-usage.test.ts` › 200 shape, 400s, 503 without a reader, admin token required; `openapi.test.ts` › route listed; `usage-store.int.test.ts` › every groupBy, filters, sorting, provider `null`.

- [ ] **T11. End-to-end pipeline: broker outage and metadata-only proof**
  - ACs: AC-2, AC-6, AC-13
  - Test: `usage-pipeline.int.test.ts` › gateway app + real producer: broker paused → buffer fills, drops counted, delivery resumes on unpause; request with a unique marker → marker absent from the Kafka message bytes and the stored row.

- [ ] **T12. Compose stack and smoke**
  - ACs: AC-8, AC-14
  - Do: `usage-worker` service, `KAFKA_BROKERS` for the gateway, smoke step.
  - Test: `scripts/compose-smoke.ts` › chat request with an admin-created key is counted in `GET /admin/usage?groupBy=key` within 10 s; topics exist.

- [ ] **T13. Docs and verification**
  - ACs: AC-2, all
  - Do: README (usage section, config, worker, roadmap), threat model *Repudiation* row, architecture, CONTRIBUTING commands if needed, verification table, spec status.
