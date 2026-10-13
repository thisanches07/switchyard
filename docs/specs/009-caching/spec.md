# Spec 009: Exact and semantic response caching

- **Status:** Approved (2026-10-13)
- **Owner:** @thisanches07
- **Release:** v0.2
- **Depends on:** 007, 008 (also uses 006 usage events and 010 PII masking, both merged earlier)
- **Related ADRs:** 0005 (Postgres + pgvector), 0006 (Redis, exact cache), 0008 (no retry after first byte), 0009 (semantic cache scoping), 0010 (no prompt persistence), 0019 (exact cache key normalisation)

## Problem
Many LLM workloads send the same request again and again: classification and extraction prompts at `temperature: 0`, test suites, retries from clients, FAQ-style questions phrased slightly differently. Each one costs a provider call, provider quota and seconds of latency, even though the answer is already known. The config schema already has `cache.exact` and `cache.semantic` sections, but nothing reads them.

Switchyard needs two caches:
- an **exact cache** in Redis for requests that are byte-for-byte the same after normalisation and are expected to be deterministic;
- an opt-in **semantic cache** in pgvector for requests that are *similar enough*, scoped so that one tenant can never receive another tenant's answer (ADR-0009).

A cache in a multi-tenant gateway is also a data store of responses, so it must be scoped, bounded in time, invisible when it fails, and honest in accounting: a hit costs nothing upstream and must not be billed as if it did, while the savings must be measurable.

## User stories
- As an **application developer**, I want repeated deterministic requests to return instantly from cache, with a header telling me it was a hit, and to be able to force or bypass the cache per request.
- As an **application developer**, I want a cached answer to arrive as a normal SSE stream when I asked for a stream, so my client code does not change.
- As an **operator**, I want to enable the semantic cache only for keys whose workload tolerates near-match answers.
- As an **operator**, I want to see hit rates and the USD the cache saved, without unknown prices being counted as savings.
- As a **security reviewer**, I want proof that a cached answer for team A is never served to team B, even for the identical prompt.
- As an **operator**, I want a Redis, Postgres or embedding outage to disable caching, not requests.

## Concepts
- **Cache key (exact):** SHA-256 over the canonical form of *(team id, candidate `provider/model`, normalised messages, output-affecting parameters)*, as defined in ADR-0019. Keys are per **candidate**: an alias request looks up the keys of all its eligible candidates (spec 008) in one round trip.
- **Semantic scope (ADR-0009):** *(team id, candidate `provider/model`, params hash)*, where the params hash is the ADR-0019 canonical form of the request **without its final user message**. Only the final user message is embedded, so earlier turns and the system prompt must match exactly.
- **Cache status:** `hit`, `semantic-hit`, `miss` (at least one lookup was made and found nothing, or failed) or `bypass` (the client asked for it, or the request was not eligible for any cache). The response header uses `semantic-hit`; the usage event uses `semantic_hit` (`waves.md`).
- **Request sent upstream:** the request after PII masking (spec 010), which is the one a cache key or embedding is computed from.

## Acceptance criteria (EARS)

### Configuration and opt-in
- **AC-1** THE migration `0005_semantic_cache` SHALL add `api_keys.semantic_cache_enabled` (`boolean`, default `false`) and the `semantic_cache_entries` table (`id`, `team_id`, `model`, `params_hash`, `embedding vector(768)`, `response jsonb`, `created_at`, `expires_at`, `hits`) with an HNSW cosine index on `embedding` and a btree index on `expires_at`. THE config file SHALL accept, besides the existing `cache.exact` and `cache.semantic` keys, `cache.semantic.maxTemperature` (default `0.3`) and `cache.semantic.lookupTimeoutMs` (default `300`). `POST /admin/keys` and `PATCH /admin/keys/:id` SHALL accept `semanticCacheEnabled` (boolean), key responses SHALL include it, and a change SHALL apply on other instances within 30 s (as in spec 005, AC-2).

### Exact cache
- **AC-2** WHEN `cache.exact.enabled` is `true` and a `/v1/chat/completions` request has `temperature` present and equal to `0`, or carries `x-switchyard-cache: force`, and asks for at most one choice (`n` absent or `1`), THE gateway SHALL look up the exact cache before calling any provider. A request with `temperature` absent (OpenAI default `1`) or above `0` and no `force` header SHALL NOT be cached. WHEN the request carries `x-switchyard-cache: bypass`, THE gateway SHALL neither read nor write any cache layer; IF the header has any other value, THEN it SHALL respond `400` `code: "invalid_cache_header"`.
- **AC-3** WHEN an exact lookup finds an entry for any eligible candidate (checked in the order of the alias strategy, spec 008), THE gateway SHALL return the stored response without calling a provider, with a new `id` and `created`, `x-switchyard-cache: hit`, `x-switchyard-provider`/`x-switchyard-model` of the candidate that originally served it and `x-switchyard-attempts: 0`. Candidates the key may not use, or entries of another team, SHALL never be read.
- **AC-4** WHEN an eligible request misses and its upstream call completes successfully with every choice's `finish_reason` in `stop`, `length` or `tool_calls`, THE gateway SHALL store the response under the serving candidate's key with TTL `cache.exact.ttlSeconds`; for a streamed miss it SHALL store the response assembled from the chunks. It SHALL NOT store anything for upstream errors, mid-stream failures (ADR-0008), client disconnects or any other `finish_reason` (e.g. `content_filter`), and the write SHALL never delay or fail the response.

### Semantic cache
- **AC-5** WHEN the exact cache did not hit, `cache.semantic.enabled` is `true`, the key has `semantic_cache_enabled`, the request's `temperature` is present and `≤ cache.semantic.maxTemperature`, it has no `tools`, `functions` or `tool_choice`, and its last message is a user message with text content, THE gateway SHALL embed that message's text with `cache.semantic.embeddingModel` through the gateway's own provider path (one attempt, no retries, bounded by `lookupTimeoutMs`, not charged to the key's rate limit or budget) and search `semantic_cache_entries` for the nearest entry with the same team, a model among the eligible candidates, the same params hash and `expires_at` in the future; IF its cosine similarity is `≥ cache.semantic.similarityThreshold`, THEN it SHALL serve that entry as in AC-3 with `x-switchyard-cache: semantic-hit` and increment the entry's `hits`. `x-switchyard-cache: force` SHALL NOT relax these conditions.
- **AC-6** WHEN a semantically eligible request misses and completes as in AC-4, THE gateway SHALL insert an entry with the embedding computed during lookup and `expires_at = now + cache.semantic.ttlSeconds`, without delaying the response; expired entries SHALL never be served and SHALL be deleted by a periodic cleanup at least once per hour.

### Streaming
- **AC-7** WHEN a request with `stream: true` hits either cache, THE gateway SHALL send the stored response as an SSE stream of `chat.completion.chunk` events ending in `data: [DONE]`, such that the official OpenAI SDK's stream accumulation yields the same message content, `tool_calls` and `finish_reason` as the stored response, and SHALL add a final usage chunk only when `stream_options.include_usage` is `true`.

### Accounting
- **AC-8** A cache hit SHALL pass the same single rate-limit and budget admission as any request (spec 005, spec 007), its token reservation SHALL be reconciled to the stored response's usage, and it SHALL add `0` to budget counters. THE usage event SHALL carry `cacheStatus` (`hit`, `semantic_hit`, `miss` or `bypass`), `attempts: 0`, `costUsd: "0"`, the stored usage as `inputTokens`/`outputTokens`, and the stored candidate as `provider`/`servedModel`; on misses `cachedInputTokens` SHALL carry the provider-reported cached prompt tokens (`usage.prompt_tokens_details.cached_tokens`), else `0`.
- **AC-9** ON every hit, THE gateway SHALL add to `switchyard_cache_savings_usd_total` the cost the stored usage would have had at the serving candidate's current price (spec 007); IF that price is unknown, THEN nothing SHALL be added and the hit SHALL be counted in `switchyard_cache_savings_unknown_total`. `switchyard_requests_total{cache}` SHALL carry the cache status and `switchyard_cache_lookups_total{layer="exact"|"semantic",result="hit"|"miss"|"error"}` every lookup.

### Isolation and privacy
- **AC-10** Integration tests (Testcontainers Redis and Postgres) SHALL show that with two teams sending the identical prompt and parameters, team B never receives team A's exact or semantic entry and its first request is a `miss`; and that within one team, a request that differs in any output-affecting parameter (e.g. `max_tokens`, `response_format`, system prompt) does not hit the other's entry.
- **AC-11** WHEN PII mode `mask` applies to the key (spec 010), THE cache key, params hash and embedding SHALL be computed from the masked request, the stored response SHALL be the upstream response with placeholders (never the restored values), and restoration SHALL happen per request after the cache; requests rejected by PII `block` SHALL never reach the cache. Cache keys, embeddings and stored content SHALL never appear in logs or span attributes (ADR-0010).

### Resilience and observability
- **AC-12** IF Redis, Postgres or the embedding call fails, times out (`lookupTimeoutMs` for semantic lookups) or returns an embedding that is not 768-dimensional, THEN THE gateway SHALL skip that cache layer, serve the request normally with `x-switchyard-cache: miss`, count it in `switchyard_cache_errors_total{layer,stage="lookup"|"write"}` and log a warning at most once per minute per layer.
- **AC-13** THE request span SHALL get `switchyard.cache.*` attributes (layer, result, similarity for semantic hits), THE contract tests SHALL show the OpenAI Node and Python SDKs reading a streamed cache hit, and THE Compose smoke test SHALL send the same `temperature: 0` request twice and observe `x-switchyard-cache: miss` then `hit`.

## Non-goals
- Caching `/v1/embeddings` responses, or chat requests with `n > 1`.
- A cache shared across teams, or scoped per key (ADR-0009).
- Admin endpoints to inspect or purge cache entries (Redis TTL and `expires_at` bound their life).
- Provider-side prompt caching controls; the gateway only reports the provider's cached token counts.
- Measuring semantic answer quality; ADR-0009's eval dataset belongs to spec 012 or later.
- Content-aware invalidation (e.g. when a model version changes behind the same name).

## Open questions
- Should a cache hit consume tokens from the TPM bucket, given that it uses no provider quota? (Proposed: yes, reconciled to the stored usage, so a client's measured throughput does not depend on cache luck and `x-ratelimit-*` stays predictable; the request unit is always charged.)
- Should a team that is over its hard budget still be served cache hits, which cost nothing? (Proposed: no; there is one admission per request and it runs before the cache, which keeps the budget rule simple to explain.)
- The exact cache stores response content in Redis for `ttlSeconds`, but is enabled per deployment, not per key, while ADR-0010 makes the semantic cache opt-in per key because it stores responses. Is the deployment-level switch enough? (Proposed: yes for v0.2: entries are in memory only (the Compose Redis has persistence off), short-lived and team-scoped; the schema default stays `false` and the README states what is stored. Add a per-key opt-out later if a tenant needs it.)
- Should `finish_reason: "length"` responses be cached? (Proposed: yes; `max_tokens` is part of the key, so the same request would get the same truncation again.)
- Should `x-switchyard-cache: force` also relax the semantic cache's temperature rule? (Proposed: no; forcing a near-match answer on a creative request is the exact risk ADR-0009 guards against.)
- Who pays for the embedding call of a semantic lookup? (Proposed: nobody in v0.2: it is not charged to the key, and it is observable through spans; the default embedding model runs on local Ollama.)
- Filtered HNSW searches can return fewer neighbours than requested when the scope filter is selective. (Proposed: the design uses pgvector's iterative index scans, available in the pinned 0.8 image, and a test with many teams checks a matching entry is still found.)
