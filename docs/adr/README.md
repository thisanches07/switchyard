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
| [0015](0015-pii-detection-and-reversible-placeholders.md) | PII detection with validated patterns and typed, numbered placeholders | Accepted |
| [0016](0016-anthropic-messages-compatibility.md) | Anthropic Messages surface translated through the canonical format | Accepted |
| [0017](0017-budget-periods-and-cost-accounting.md) | Exact-decimal costs, calendar-month (UTC) budgets, no cost reservation | Accepted |
| [0018](0018-config-hot-reload.md) | Config hot reload by polling, plus admin endpoint and SIGHUP | Accepted |
| [0019](0019-exact-cache-key-normalisation.md) | Exact cache keys: canonical JSON + SHA-256, scoped by team | Accepted |
| [0020](0020-dashboards-and-alerts-as-code.md) | Grafana dashboards and alerts as file-provisioned JSON/YAML | Accepted |
| [0021](0021-benchmark-methodology.md) | Benchmark methodology: containerised k6 with a direct baseline | Accepted |
