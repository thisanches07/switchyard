# Spec backlog

Specs 006–015 were drafted together and are implemented in parallel **waves**: see [waves.md](waves.md) for the wave plan and the contracts shared between specs. This backlog defines **scope, dependencies and the release** of every planned spec so the work can run end to end. When a spec is drafted, its full ACs live in its own folder; this file only tracks scope and status.

Status: `planned` → `draft` → `approved` → `in progress` → `done`.

## v0.1: working gateway

| # | Spec | Scope (what the full spec must cover) | Depends on | Status |
|---|---|---|---|---|
| 001 | bootstrap | Repo tooling, Docker Compose (Postgres+pgvector, Redis, Redpanda, otel-lgtm, optional Ollama profile), Fastify skeleton with `/healthz` `/readyz`, config loading + Zod validation, pino + OTel wiring, graceful shutdown, CI (lint, typecheck, unit, build) | n/a | done |
| 002 | chat-proxy | Canonical types (ADR-0004), `openai-compatible` and `mock` adapters, `POST /v1/chat/completions` **non-streaming**, `GET /v1/models`, OpenAI error shape, `x-switchyard-*` response headers, contract test with the official OpenAI Node SDK against `mock` and Ollama | 001 | done |
| 003 | streaming | SSE streaming pass-through with backpressure, `stream_options.include_usage` handling and token estimation fallback, client disconnect aborts upstream, TTFB metric, contract tests (Node + Python SDK) for streams, `POST /v1/embeddings` | 002 | done |
| 004 | keys-and-teams | Drizzle schema + migrations for `teams` and `api_keys`, key format `sk-sy-…`, SHA-256 + pepper hashing, constant-time compare, in-memory LRU auth cache, allowed models per key, Admin API (`/admin/teams`, `/admin/keys`, revoke) behind `ADMIN_TOKEN`, OpenAPI at `/docs` | 002 | done |
| 005 | rate-limiting | Token bucket Lua script for RPM and TPM per key and team, TPM reservation + reconciliation, OpenAI-style `x-ratelimit-*` headers and 429, fail-open policy when Redis is down (ADR-0006), integration tests on real Redis | 004 | done |
| 006 | usage-pipeline | `UsageEvent` schema (UUIDv7), producer with bounded buffer and drop metric, topics `usage.events.v1` + DLQ, worker process with idempotent insert and `usage_daily` aggregation, `GET /admin/usage` | 004 | done |
| 007 | budgets | `config/pricing.yaml` loading and cost calculation (schema accepts `number | "TODO"`; `TODO` means *unknown cost*, flagged in metrics and never counted as 0; supports glob keys like `mock/*`), monthly budgets per key/team with soft and hard limits, Redis hot counters, reconciliation job against Postgres, budget headers and 402/429 behaviour | 005, 006 | approved |
| 008 | routing-resilience | Aliases and strategies (`priority`, `lowest-cost`, `lowest-latency` with EWMA), retries with jittered backoff and `Retry-After`, per-candidate circuit breaker, separate connect/TTFB/total timeouts, no retry after first byte (ADR-0008), config hot reload, `/admin/providers/health`, chaos test (30% upstream failures ⇒ ≥ 99% success) | 003, 006 | approved |

**v0.1 release checklist:** README quickstart works from a clean clone · contract tests green · first blog post.

## v0.2: savings and safety

| # | Spec | Scope | Depends on | Status |
|---|---|---|---|---|
| 009 | caching | Exact cache in Redis (temperature 0 or forced), semantic cache in pgvector with scoping from ADR-0009, cached responses re-chunked as streams, hit-rate and USD-saved metrics, cross-tenant isolation test | 007, 008 | approved |
| 010 | pii-redaction | Detectors (email, phone BR/E.164, card with Luhn, CPF/CNPJ with check digits, IP, custom deny-list), modes `off/mask/block` per key, `mask` replaces values in the request (streaming included) and restores them in **non-streaming** responses; in streaming responses placeholders like `<CPF_1>` stay unrestored until spec 015; `block` is a separate opt-in, detection metrics, no raw values in logs | 004 | done |

## v0.3: proof and production

| # | Spec | Scope | Depends on | Status |
|---|---|---|---|---|
| 011 | observability | Grafana dashboards as code (overview, cost, providers, cache), GenAI semantic conventions on spans, alert rules examples, screenshots in README | 008 | approved |
| 012 | benchmarks | k6 scenarios (`no-cache`, `exact-cache`, `streaming`, `rate-limited`, `chaos`), mock provider tuning, methodology and hardware in `docs/benchmarks.md`, numbers published in README | 009, 011 | approved |
| 013 | deploy | Multi-arch Docker images to GHCR, Terraform for Oracle Always Free (ADR-0012), cloud-init + Compose, demo key with hard budget, release workflow | 012 | approved |

## Stretch

| # | Spec | Scope | Status |
|---|---|---|---|
| 014 | anthropic | Outbound `anthropic` provider adapter (so `claude/*` candidates work through `/v1/chat/completions`) and inbound Anthropic-compatible `POST /v1/messages`, with tool-use translation both ways | done |
| 015 | pii-streaming-restore | Restore masked values in streaming responses (placeholder split across chunks, boundary buffering) | approved |
