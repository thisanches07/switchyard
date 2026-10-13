# Delivery waves and shared contracts (specs 006–015)

Specs 006–015 are drafted together and approved in one round, then implemented in **waves**: specs inside a wave run in parallel (one agent, one git worktree and one branch each); a wave starts only when every spec it depends on is merged. Each spec's `design.md` is written at the start of its wave, against the code that actually exists then.

This file pins the things parallel specs would otherwise disagree on. A spec may refine a contract below (e.g. add an optional field), but must not rename or remove one; changes go through this file in the same PR.

## Waves

| Wave | Specs (parallel) | Waits for |
|---|---|---|
| A | 006 usage-pipeline · 010 pii-redaction · 014 anthropic | 005 (done) |
| B | 007 budgets · 008 routing-resilience | 006 |
| C | 009 caching · 011 observability · 015 pii-streaming-restore | 007, 008 (009, 011) · 010 (015) |
| D | 012 benchmarks → 013 deploy | 009, 011 → 012 |

**Merge order inside a wave** is the order listed (006 first in wave A: it owns the request-outcome hook the others plug into). The integrator merges one PR at a time, only with CI green on the exact commit, and rebases the rest.

## Reserved numbers

| Spec | Migration | ADR numbers |
|---|---|---|
| 006 usage-pipeline | `0002_usage_events` | (none expected; ADR-0007 covers it) |
| 010 pii-redaction | `0003_pii_mode` | 0015 PII detection and reversible placeholders |
| 014 anthropic | none | 0016 Anthropic Messages compatibility surface |
| 007 budgets | `0004_budgets` | 0017 budget periods and cost accounting |
| 008 routing-resilience | none | 0018 config hot reload |
| 009 caching | `0005_semantic_cache` | 0019 exact cache key normalisation |
| 011 observability | none | 0020 dashboards and alerts as code |
| 012 benchmarks | none | 0021 benchmark methodology |
| 013 deploy | none | 0022 (only if the ADR-0012 fallback is used) |
| 015 pii-streaming-restore | none | (none expected) |

Migrations are applied in merge order. `drizzle/meta/_journal.json` and the snapshots conflict even when numbers differ: whoever merges second regenerates them on top of `main` (`pnpm db:generate`) instead of hand-merging.

## Data model additions

| Table | Column | Type | Owner |
|---|---|---|---|
| `usage_events` | see UsageEvent below | | 006 |
| `usage_daily` | `day`, `team_id`, `key_id`, `model`, `requests`, `input_tokens`, `output_tokens`, `cost_usd`, `unknown_cost_requests`; PK (`day`, `team_id`, `key_id`, `model`) | | 006 |
| `api_keys` | `pii_mode` | enum `off`/`mask`/`block`, NULL = config default | 010 |
| `teams` | `monthly_budget_usd` | `numeric(12,4)` NULL = no budget | 007 |
| `teams` | `soft_limit_pct` | `integer` 1–100, default 80 | 007 |
| `api_keys` | `monthly_budget_usd` | `numeric(12,4)` NULL = no budget | 007 |
| `api_keys` | `semantic_cache_enabled` | `boolean` default false | 009 |
| `semantic_cache_entries` | `id`, `team_id`, `model`, `params_hash`, `embedding vector(768)`, `response jsonb`, `created_at`, `expires_at`, `hits`; HNSW index | | 009 |

## Config keys (`src/config/schema.ts`)

Existing stubs are reused, not reinvented: `retry`, `circuitBreaker`, `aliases[].strategy` and `server.timeouts` belong to 008; `cache.exact` and `cache.semantic` to 009; `pricingFile` to 007.

| New key | Owner |
|---|---|
| `usage` (`enabled`, `topic` = `usage.events.v1`, `dlqTopic` = `usage.events.dlq`, `bufferSize`, `flushIntervalMs`) + env `KAFKA_BROKERS` | 006 |
| `pii` (`defaultMode`, `detectors`, `denyList`) | 010 |
| `budgets` (`onRedisError` default `closed`, `reconcileIntervalSeconds`) | 007 |
| `routing` (`ewmaAlpha`, `hotReload`) | 008 |

## UsageEvent v1 (topic `usage.events.v1`, key = team id)

Spec 006 defines the full v1 schema, including fields that later specs fill in, so they never have to change the topic version. Fields owned by a later spec are emitted with the default shown until that spec lands.

| Field | Type | Default until filled | Filled by |
|---|---|---|---|
| `id` | UUIDv7 | | 006 |
| `schemaVersion` | `1` | | 006 |
| `occurredAt` | ISO-8601 UTC | | 006 |
| `requestId` | string (same as `x-switchyard-request-id`) | | 006 |
| `teamId`, `keyId` | UUID | | 006 |
| `operation` | `chat` · `embeddings` · `messages` | | 006 (`messages`: 014) |
| `stream` | boolean | | 006 |
| `requestedModel` | string (what the client sent) | | 006 |
| `provider`, `servedModel` | string, NULL if no upstream was reached | | 006 |
| `inputTokens`, `outputTokens` | integer | | 006 |
| `cachedInputTokens` | integer, **provider-reported** prompt-cache read tokens (not Switchyard's own cache) | `0` | 006 (OpenAI `prompt_tokens_details.cached_tokens`), 014 (Anthropic `cache_read_input_tokens`) |
| `estimated` | boolean (usage estimated, spec 003) | | 006 |
| `costUsd` | decimal string or NULL (NULL = unknown cost, never 0) | NULL | 007 |
| `status` | HTTP status returned to the client | | 006 |
| `outcome` | `success` · `upstream_error` · `upstream_error_midstream` (ADR-0008) · `client_closed` · `rejected` (admitted, then refused by a gateway policy such as PII `block`, no upstream call) | | 006 |
| `errorCode` | string or NULL | | 006 |
| `latencyMs` | integer, whole request | | 006 |
| `ttfbMs` | integer or NULL (streams only) | | 006 |
| `attempts` | integer ≥ 0 (`0` = no upstream call: policy rejection, cache hit) | `1` (`0` when no upstream call) | 008 |
| `cacheStatus` | `miss` · `hit` · `semantic_hit` · `bypass` | `miss` | 009 |
| `piiDetections` | object `{ type: count }` | `{}` | 010 |

Events are emitted for every authenticated `/v1` request that passed admission (rate limit, and budget from 007). Requests rejected before admission are counted in metrics only.

**One outcome hook.** Spec 006 introduces a single request-outcome point in `src/modules/proxy` (the non-streaming `settle()` path and the stream's end, failure and disconnect paths). Later specs add data to it (cost, budget counters, attempts, cache status, PII counts) rather than adding new completion paths.

## Metrics (names are fixed)

`switchyard_requests_total{model,provider,status,cache}` · `switchyard_request_duration_seconds` · `switchyard_ttfb_seconds` · `switchyard_gateway_overhead_seconds` · `switchyard_tokens_total{direction}` · `switchyard_cost_usd_total` · `switchyard_cache_savings_usd_total` · `switchyard_ratelimit_rejections_total` · `switchyard_budget_rejections_total` · `switchyard_circuit_state{candidate}` · `switchyard_usage_events_dropped_total` · `switchyard_pii_detections_total{type}`

Label lists are the minimum: labels that already exist (e.g. `team` on `switchyard_requests_total`, spec 004) stay. Added by specs: `switchyard_budget_used_ratio{scope,id}` (007, read by 011's alerts). Other new metrics follow the `switchyard_<area>_<what>_<unit|total>` pattern and are named in their spec.

## Hotspot files

These files are touched by most specs. Keep edits to them small and additive (new lines, new entries) so rebases stay mechanical: `src/app.ts`, `src/server.ts`, `src/config/schema.ts`, `src/modules/docs.ts`, `src/modules/proxy/routes.ts`, `src/modules/proxy/stream.ts`, `config/switchyard.example.yaml`, `docker-compose.yml`, `scripts/compose-smoke.ts`, `README.md`, `docs/threat-model.md`.

## Local resources

Integration tests start real containers. On the reference machine (16 GB), run at most **one** agent's `pnpm test:int` at a time; CI runs the full suite on every PR.
