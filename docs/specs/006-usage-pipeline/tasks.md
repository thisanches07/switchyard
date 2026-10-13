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

- [x] **T3. Outcome tracker**
  - ACs: AC-3
  - Do: `src/modules/usage/outcome.ts` (`createOutcomeHook`, tracker, request augmentation), `recorders.ts` (`noopRecorder`, `fanOut`).
  - Test: `test/unit/usage/outcome.test.ts` › success, fail (GatewayError and unknown error), failMidstream, clientClosed (200/499), reject (provider null, attempts 0, tokens 0), `set()` contributions, exactly one event when two terminal calls race, recorder errors swallowed.

- [x] **T4. Wire the hook into chat, embeddings and streams**
  - ACs: AC-2, AC-3
  - Do: `AppDeps.usageRecorder`; `admit()` begins the tracker; `settle()` and `streamChat` end it; `onResponse` safety net; provider-reported `cachedInputTokens` (`usage.prompt_tokens_details.cached_tokens`).
  - Test: `test/unit/usage/routes-outcome.test.ts` › one event per case (chat/embeddings, stream/non-stream, success/upstream error/mid-stream/disconnect), none for 401/404/429, cached tokens, marker absent from the event JSON; `openai-compatible.test.ts`/`usage.test.ts` › cached tokens parsed.

- [x] **T5. Usage publisher (bounded buffer)**
  - ACs: AC-1, AC-5, AC-6, AC-7, AC-12
  - Do: `src/modules/usage/publisher.ts`, `telemetry.ts`.
  - Test: `test/unit/usage/publisher.test.ts` › validates before buffering, disabled never sends, record is synchronous, key = team id, periodic flush, failed send kept and retried, buffer full → drop + metric + one warning per minute, close flushes and counts leftovers as `shutdown`, gauge and published counter.

- [x] **T6. Kafka producer and gateway wiring**
  - ACs: AC-4, AC-5, AC-6, AC-7
  - Do: `src/infra/kafka/{client,producer}.ts`, `server.ts` (required `KAFKA_BROKERS`, publisher start, closer with deadline), `installShutdown` passes `{ deadlineAt }`, `@testcontainers/redpanda`.
  - Test: `boot.test.ts` › missing `KAFKA_BROKERS` exits naming it, starts with Kafka unreachable; `shutdown.test.ts` › closers receive the deadline; `test/integration/usage-producer.int.test.ts` › events published to Redpanda with the team id as key.

- [x] **T7. Migration `0002_usage_events` and the usage store**
  - ACs: AC-8, AC-9, AC-10
  - Do: Drizzle tables, generated migration, `DrizzleUsageStore.insertEvents`.
  - Test: `test/integration/usage-store.int.test.ts` › row with every field (exact `cost_usd`), daily aggregate, same event twice → one row counted once, unknown costs counted apart, model = provider/servedModel or requested model; `db.int.test.ts` › table list.

- [x] **T8. Worker batch processing**
  - ACs: AC-1, AC-9, AC-10, AC-12
  - Do: `src/modules/usage/consume.ts` (+ worker metric and span).
  - Test: `test/unit/usage/consume.test.ts` › valid stored, duplicates counted, invalid JSON and schema failures → DLQ with original bytes and headers, Postgres error → throws before any DLQ, in-batch duplicate ids, `switchyard_usage_worker_events_total`, `switchyard.usage.consume` span without content.

- [x] **T9. Worker process and consumer**
  - ACs: AC-8, AC-9, AC-10, AC-13
  - Do: `src/infra/kafka/{consumer,topics}.ts`, `src/worker.ts`, `pnpm dev:worker`.
  - Test: `test/integration/usage-pipeline.int.test.ts` › topics created, publish → row + aggregate, same event twice → counted once, malformed → DLQ while the next valid one is stored, worker restart mid-stream → no loss and no double count.

- [x] **T10. `GET /admin/usage`**
  - ACs: AC-11
  - Do: `src/modules/usage/report.ts`, admin route, OpenAPI docs, `DrizzleUsageStore.summarize`.
  - Test: `test/unit/usage/report.test.ts` › defaults, validation (dates, ids, order, 366 days, groupBy), decimal normalisation; `test/unit/admin/admin-usage.test.ts` › 200 shape, 400s, 503 without a reader, admin token required; `openapi.test.ts` › route listed; `usage-store.int.test.ts` › every groupBy, filters, sorting, provider `null`.

- [x] **T11. End-to-end pipeline: broker outage and metadata-only proof**
  - ACs: AC-2, AC-6, AC-13
  - Test: `usage-pipeline.int.test.ts` › gateway app + real producer: broker paused → buffer fills, drops counted, delivery resumes on unpause; request with a unique marker → marker absent from the Kafka message bytes and the stored row.

- [x] **T12. Compose stack and smoke**
  - ACs: AC-8, AC-14
  - Do: `usage-worker` service, `KAFKA_BROKERS` for the gateway, smoke step.
  - Test: `scripts/compose-smoke.ts` › chat request with an admin-created key is counted in `GET /admin/usage?groupBy=key` within 10 s; topics exist.

- [x] **T13. Docs and verification**
  - ACs: AC-2, all
  - Do: README (usage section, config, worker, roadmap), threat model *Repudiation* row, architecture, CONTRIBUTING commands if needed, verification table, spec status.

## Verification (2026-10-13)

| AC | Proven by | Result |
|---|---|---|
| AC-1 | `test/unit/usage/schema.test.ts` › strict v1 schema (unknown fields, `schemaVersion`, UUIDv7, negative tokens, `costUsd` format); `publisher.test.ts` › invalid events dropped before buffering; `consume.test.ts` › schema failures go to the DLQ | ✅ |
| AC-2 | `routes-outcome.test.ts` › marker absent from events of chat, stream and embeddings; `usage-pipeline.int.test.ts` › marker absent from the Kafka message bytes and the stored row (`row_to_json`); threat model *Repudiation* row updated | ✅ |
| AC-3 | `outcome.test.ts` › every terminal case, `reject`, contributions, exactly one event; `routes-outcome.test.ts` › chat/embeddings × stream/non-stream × success, upstream error, mid-stream failure, client disconnect (200 and 499), cached tokens, no event for 400/401/403/404/429 or `/v1/models`, fallback for routes that forget; `publisher.test.ts` › `usage.enabled: false` builds and validates without a producer | ✅ |
| AC-4 | `schema.test.ts` › `usage` defaults and validation; `env.test.ts` › `KAFKA_BROKERS`, worker env; `boot.test.ts` › gateway exits naming `KAFKA_BROKERS` | ✅ |
| AC-5 | `publisher.test.ts` › synchronous record, key = team id, periodic flush; `usage-producer.int.test.ts` › messages on Redpanda keyed by team id | ✅ |
| AC-6 | `publisher.test.ts` › buffer full → drop + metric + one warning per minute, retry after failed sends; `boot.test.ts` › gateway starts and `/healthz` answers with Kafka unreachable; `usage-pipeline.int.test.ts` › broker paused: buffer fills, 7 drops counted, delivery resumes after unpause | ✅ |
| AC-7 | `publisher.test.ts` › close flushes in batches, leftovers counted `shutdown`, retries until the deadline; `shutdown.test.ts` › closers receive the deadline | ✅ |
| AC-8 | `usage-store.int.test.ts` › every field stored, exact `cost_usd`, daily aggregate per UTC day/team/key/model; `usage-pipeline.int.test.ts` › topics created at startup, publish → row + aggregate; smoke › topics exist | ✅ |
| AC-9 | `usage-store.int.test.ts` › same event twice (separate and same batch) counted once; `usage-pipeline.int.test.ts` › duplicate publish, worker "killed" after the DB commit and restarted: 40/40 rows, 40 requests | ✅ |
| AC-10 | `consume.test.ts` › DLQ with original bytes and reason/partition/offset headers, Postgres down → no DLQ, error rethrown; `usage-store.int.test.ts` › known costs summed, unknown counted, unreachable DB throws even for empty batches; `usage-pipeline.int.test.ts` › malformed → DLQ while the next valid one is stored | ✅ |
| AC-11 | `report.test.ts` › defaults, validation, 366-day limit, decimals; `admin-usage.test.ts` › response shape, 400s, 401, 503 without a store; `openapi.test.ts` › route documented; `usage-store.int.test.ts` › every `groupBy`, filters, sorting, provider `null` | ✅ |
| AC-12 | `publisher.test.ts` › dropped/published counters and buffer gauge; `consume.test.ts` › worker counter and `switchyard.usage.consume` span without content | ✅ |
| AC-13 | `test/integration/usage-pipeline.int.test.ts` (Redpanda + Postgres via Testcontainers): 7/7 | ✅ |
| AC-14 | `scripts/compose-smoke.ts` › `usage-worker` service, topics exist, chat request counted in `GET /admin/usage?groupBy=key` within 10 s; verified by the CI `compose-smoke` job (see note) | ⏳ CI |

Notes:
- AC-14: the local Compose smoke could not run on the reference machine (Docker Desktop left the gateway-image containers stuck in "Created"; the image itself built, including the Kafka client's prebuilt binary). By the owner's decision the smoke is verified by the CI `compose-smoke` job. The script gained a timeout on every Docker call (120 s for `compose run`) so a hung daemon fails the step instead of blocking.
- The full integration suite for this spec (`usage-producer`, `usage-store`, `usage-pipeline`, `db`) passes locally under Testcontainers.
- Spec open questions resolved as proposed, except two fallbacks the proposals allowed: Kafka is not reported in `/readyz`, and `groupBy=provider` reads `usage_events` (design §10).
- Kafka client: `@confluentinc/kafka-javascript` 1.11.0 (prebuilt librdkafka on Windows x64 and Linux), as ADR-0007 decided; no fallback needed.
- Non-streaming requests whose provider reports no usage are recorded with the spec 003 estimate (`estimated: true`); the rate limiter keeps its spec 005 behaviour (reservation kept) for that case.
