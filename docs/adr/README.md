# Architecture Decision Records

Format: [MADR](0000-template.md). New ADRs start as **Proposed** and become **Accepted** when reviewed.

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions and develop spec-first | Accepted |
| [0002](0002-node-typescript-fastify.md) | Node.js 24 LTS, TypeScript strict, Fastify 5 | Accepted |
| [0003](0003-openai-compatible-api.md) | OpenAI-compatible API as the public surface | Accepted |
| [0004](0004-canonical-format-and-adapters.md) | Canonical internal format with provider adapters | Accepted |
| [0005](0005-postgres-pgvector.md) | Postgres + pgvector, `nomic-embed-text` 768-dim | Accepted |
| [0006](0006-redis-limits-and-counters.md) | Redis + Lua for limits, budget counters, exact cache | Accepted |
| [0007](0007-kafka-usage-events.md) | Kafka (Redpanda) usage events, idempotent consumer, DLQ | Accepted |
| [0008](0008-no-retry-after-first-byte.md) | No retry or fallback after the first streamed byte | Accepted |
| [0009](0009-semantic-cache-scoping.md) | Semantic cache scoped by team + model + params | Accepted |
| [0010](0010-no-prompt-persistence.md) | Do not persist or log prompt content by default | Accepted |
| [0011](0011-opentelemetry.md) | OpenTelemetry as the single telemetry API | Accepted |
| [0012](0012-deploy-oracle-always-free.md) | Demo on Oracle Cloud Always Free via Terraform | Accepted |
| [0013](0013-toolchain.md) | Toolchain: pnpm, ESM, tsc, tsx, Vitest, Biome, Testcontainers | Accepted |
| [0014](0014-zod-validation-openapi-docs.md) | Zod validation; Fastify route schemas only for OpenAPI docs | Accepted |
