# Tasks 009: Exact and semantic response caching

- **Status:** In progress
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-009]`. Lint, typecheck and the task's tests at each commit; full `pnpm verify` and integration suite at the end.

- [x] **T1. Config, ports and cache key**
  - ACs: AC-1 (config keys), AC-10 (key scope), AC-11 (key from the sent request)
  - Do: `cache.semantic.maxTemperature`, `lookupTimeoutMs`; `src/core/cache.ts` ports and `cachedResponseSchema`; `canonicalJson`, `exactKey`, `paramsHash` (ADR-0019).
  - Test: `test/unit/config/schema.test.ts` › cache defaults and bounds; `test/unit/cache/key.test.ts` › key order and whitespace, excluded fields, null removal (top level, messages, not nested), array order, team and candidate in key, each output-affecting parameter changes the key, params hash ignores the final user message.
  - Files: `src/config/schema.ts`, `src/core/cache.ts`, `src/modules/cache/key.ts`

- [x] **T2. Eligibility and the cache header**
  - ACs: AC-2, AC-5
  - Test: `test/unit/cache/eligibility.test.ts` › header values (absent, force, bypass, case, invalid → 400), temperature 0 / absent / > 0 / force, `n`, semantic temperature cap and tools, last message user text (string, text parts, image part, assistant last).
  - Files: `src/modules/cache/eligibility.ts`, `src/core/errors.ts`

- [ ] **T3. Response assembly and re-chunking**
  - ACs: AC-4, AC-7
  - Test: `test/unit/cache/chunks.test.ts` › cacheable finish reasons, assemble content / tool_calls / usage from chunks, rechunk round trip (assemble(rechunk(x)) ≡ x), usage chunk last.
  - Files: `src/modules/cache/chunks.ts`

- [ ] **T4. In-memory stores**
  - ACs: AC-3, AC-6 (expiry)
  - Test: `test/unit/cache/memory-stores.test.ts` › exact TTL on injected clock, bound, getMany order; semantic nearest in scope only, expired never returned, hits, deleteExpired.
  - Files: `src/infra/memory/{exact-cache,semantic-cache}.ts`

- [ ] **T5. Key opt-in: migration, store, admin, principal**
  - ACs: AC-1
  - Do: Drizzle schema (`semantic_cache_enabled`, `semantic_cache_entries`, HNSW, btree), `pnpm db:generate --name semantic_cache` + `CREATE EXTENSION`; key store, memory key store, admin body/patch/view, OpenAPI docs, `Principal.semanticCacheEnabled`.
  - Test: `test/unit/admin/admin-cache.test.ts` › create/patch/list, invalid type 400, principal after patch; `test/integration/db.int.test.ts` › semantic cache migration (column default, table, indexes).
  - Files: `src/infra/db/{schema,key-store}.ts`, `drizzle/0005_semantic_cache.sql`, `src/core/auth.ts`, `src/modules/admin/routes.ts`, `src/modules/docs.ts`, `src/modules/auth/authenticate.ts`, `test/helpers/{memory-key-store,admin}.ts`

- [ ] **T6. Cache telemetry and request counter label**
  - ACs: AC-9, AC-12 (warn limiter), AC-13 (span attributes)
  - Test: `test/unit/cache/telemetry.test.ts` › counters and labels, one warning per minute per layer on an injected clock, span attributes without content; `test/unit/proxy/telemetry.test.ts` › `cache` label on requests_total.
  - Files: `src/modules/cache/telemetry.ts`, `src/modules/proxy/{telemetry,attempts}.ts`

- [ ] **T7. Exact cache in the chat route**
  - ACs: AC-2, AC-3, AC-4, AC-8, AC-9, AC-11, AC-12
  - Test: `test/unit/proxy/cache-routes.test.ts` › miss then hit (JSON), headers, alias strategy order, team scope, bypass/force/invalid header, non-cacheable finish reason and errors not stored, n > 1; `test/unit/proxy/cache-accounting.test.ts` › usage event, TPM reconcile, budget 0, savings known/unknown; `test/unit/proxy/cache-pii.test.ts` › key on masked request, stored placeholders, restored per request, block never reaches cache; `test/unit/proxy/cache-failures.test.ts` › exact store errors → miss.
  - Files: `src/modules/cache/stage.ts`, `src/modules/proxy/{routes,cached,messages}.ts`, `src/app.ts`, `test/helpers/app.ts`

- [ ] **T8. Streaming: store streamed misses, re-chunk hits**
  - ACs: AC-4, AC-7, AC-8
  - Test: `cache-routes.test.ts` › streamed miss stored and served as JSON, JSON miss served as stream, include_usage, midstream failure and client close not stored.
  - Files: `src/modules/proxy/{stream,routes,cached}.ts`

- [ ] **T9. Semantic cache in the stage, Postgres store and cleanup**
  - ACs: AC-5, AC-6, AC-12
  - Test: `test/unit/proxy/semantic-cache.test.ts` › opt-in, hit above threshold, below threshold miss, params hash scope, force does not relax, write with embedding, hits incremented, timeout on manual clock, wrong dimensions, embedding error; `test/unit/cache/cleanup.test.ts`; `test/integration/semantic-cache.int.test.ts` › nearest, scope, expiry, iterative scan with many teams, deleteExpired.
  - Files: `src/modules/cache/{stage,cleanup}.ts`, `src/infra/db/semantic-cache.ts`, `src/server.ts`

- [ ] **T10. Redis store and isolation**
  - ACs: AC-10, AC-12
  - Test: `test/integration/cache-isolation.int.test.ts` › two teams identical prompt (exact and semantic) never share, first request miss; differing `max_tokens` / `response_format` / system prompt miss; Redis stopped → miss.
  - Files: `src/infra/redis/exact-cache.ts`, `src/server.ts`

- [ ] **T11. Contract and smoke**
  - ACs: AC-7, AC-13
  - Test: `test/contract/openai-sdk.contract.test.ts` › streamed cache hit; `test/contract/python/test_openai_sdk.py` › streamed cache hit; `scripts/compose-smoke.ts` › miss then hit.
  - Files: those, `scripts/contract-python.ts`

- [ ] **T12. Docs and verification**
  - Do: README caching section and roadmap, `docs/architecture.md`, threat-model cross-tenant row, example config, OpenAPI; verification table; spec `Done`.
  - Files: `README.md`, `docs/**`, `config/switchyard.example.yaml`
