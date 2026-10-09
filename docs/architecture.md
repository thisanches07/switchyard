# Architecture

Switchyard is a stateless HTTP gateway backed by Redis (hot state), Postgres (durable state and vectors) and Kafka (usage events). Decisions behind each choice are recorded in [ADRs](adr).

## Context

```mermaid
flowchart LR
  C[Client apps<br/>OpenAI SDK] -->|HTTPS| G[Switchyard gateway]
  A[Operator] -->|Admin API| G
  G --> P[LLM providers<br/>OpenAI · Anthropic · Gemini · Groq · OpenRouter · Ollama]
  G <--> R[(Redis)]
  G <--> DB[(Postgres + pgvector)]
  G -->|usage.events.v1| K[[Kafka / Redpanda]]
  K --> W[Usage worker] --> DB
  G -. OTLP .-> O[OTel Collector → Grafana]
  W -. OTLP .-> O
```

## Processes

| Process | Entry point | Responsibility |
|---|---|---|
| Gateway | `src/server.ts` | Public `/v1/*` API, Admin API, health endpoints |
| Usage worker | `src/worker.ts` | Consume usage events, idempotent insert, daily aggregates, DLQ |

Both are stateless and can run several instances.

## Request pipeline

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant G as Gateway
  participant R as Redis
  participant D as Postgres
  participant P as Provider
  participant K as Kafka

  C->>G: POST /v1/chat/completions
  G->>G: auth (LRU cache → Postgres)
  G->>R: rate limit (Lua) + budget check
  G->>G: PII redaction (if enabled)
  G->>R: exact cache lookup
  G->>D: semantic cache lookup (if enabled)
  alt cache hit
    G-->>C: cached response (re-chunked if stream)
  else cache miss
    G->>P: upstream call (retry/fallback until first byte)
    P-->>G: response / SSE chunks
    G-->>C: response / SSE chunks (+ PII restore)
  end
  G->>R: reconcile TPM and budget
  G->>K: publish UsageEvent
```

Each stage is a small module with its own span (`switchyard.auth`, `switchyard.ratelimit`, …), so traces show exactly where time goes.

## Code layout

```
src/
├─ server.ts / worker.ts / app.ts
├─ config/      Zod schema, loader, hot reload
├─ core/        canonical types, errors, ports (interfaces), no infra imports
├─ modules/     auth · ratelimit · budget · pii · cache · routing · providers · proxy · usage · admin
└─ infra/       db (Drizzle) · redis · kafka · telemetry · logger
```

Dependency rule: `modules → core ← infra`. `core` never imports `modules` or `infra`. The Fastify app is built by `buildApp(deps)` so tests inject fakes.

## Data model

| Table | Purpose |
|---|---|
| `teams` | Tenant, monthly budget, soft limit percentage |
| `api_keys` | Hashed virtual keys, allowed models, limits, PII mode, cache opt-in, status |
| `usage_events` | One row per request (metadata only, ADR-0010), id = UUIDv7 |
| `usage_daily` | Aggregates per day/team/key/model |
| `semantic_cache_entries` | Embedding `vector(768)` + response, scoped by team/model/params (ADR-0009), HNSW index |

## Failure behaviour

| Dependency down | Behaviour |
|---|---|
| Provider | Retry with backoff, then next candidate; circuit breaker opens after repeated failures |
| Redis | Rate limits fail open, hard budgets fail closed (configurable), exact cache skipped |
| Postgres | Auth served from LRU cache for known keys; new keys fail with 503; semantic cache skipped |
| Kafka | Events buffered in memory up to a bound, then dropped and counted |

## Related documents
- [Spec backlog](specs/README.md)
- [Threat model](threat-model.md)
- [Benchmarks](benchmarks.md)
