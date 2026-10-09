# 0007. Publish usage events to Kafka (Redpanda) and persist them with an idempotent consumer

- **Status:** Proposed
- **Date:** 2026-10-09
- **Related specs:** 006, 007

## Context
Every request produces a usage record (tokens, cost, latency, cache status). Writing it synchronously to Postgres would add latency and couple the hot path to analytical writes.

## Options considered
1. **Kafka API (Redpanda locally) + separate worker**: decoupled, replayable, the event-driven pattern senior roles ask for.
2. **Redis Streams**: simpler, already deployed, but weaker ecosystem for replay and consumer groups at scale, and less relevant for the target job market.
3. **Direct async insert into Postgres**: simplest, but couples gateway latency and availability to the database.

Kafka client libraries:
- **`@confluentinc/kafka-javascript`**: maintained by Confluent, librdkafka-based, KafkaJS-compatible API. Prebuilt binaries exist for Windows x64 + Node 24 (ABI 137), verified on v1.11.0 (2026-10-09).
- **`@platformatic/kafka`**: modern pure-TypeScript client, no native build, actively released.
- **KafkaJS**: no release since 2023, so treated as unmaintained.

## Decision
Use **Redpanda** locally (Kafka API) and **`@confluentinc/kafka-javascript`** as the client; keep `@platformatic/kafka` as the fallback if native builds cause trouble. Topics: `usage.events.v1` (key = team id) and `usage.events.dlq`. Event ids are **UUIDv7**. The worker inserts with `ON CONFLICT (id) DO NOTHING` (idempotent), updates `usage_daily`, and sends invalid messages to the DLQ. The producer uses a bounded in-memory buffer; if the broker is unavailable and the buffer fills, events are **dropped and counted** (`switchyard_usage_events_dropped_total`) rather than blocking user requests.

## Consequences
- ✅ Hot path stays fast; analytics can be replayed and reprocessed.
- ✅ At-least-once delivery + idempotent consumer gives effectively-once storage.
- ⚠️ Dropping events under prolonged broker outage loses usage data; acceptable for a gateway (budget counters in Redis still enforce limits), and visible in metrics.
- ⚠️ One more service to run; Redpanda is configured with `--smp 1 --memory 1G` locally.
- 🔁 Revisit with an on-disk outbox if lost usage events become unacceptable (e.g. for real billing).
