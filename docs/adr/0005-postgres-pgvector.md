# 0005. Use PostgreSQL + pgvector for state and the semantic cache

- **Status:** Accepted
- **Date:** 2026-10-09
- **Related specs:** 004, 006, 009

## Context
We need durable storage for teams, keys and usage, plus vector similarity search for the semantic cache. Fewer moving parts matter for a self-hosted product that must run on a 16 GB laptop and on free-tier hosting.

## Options considered
1. **Postgres 17 + pgvector (HNSW index)**: one database for relational and vector data, transactional, available on Neon/Supabase free tiers.
2. **Postgres + dedicated vector DB (Qdrant, Weaviate)**: better at very large scale, one more service to run and secure.
3. **Redis vector search**: fast, but makes Redis a durable store, which we want to avoid.

## Decision
Use **Postgres 17 with pgvector** and an **HNSW** index (cosine distance). Access through **Drizzle ORM** with SQL migrations from `drizzle-kit`. The embedding model is fixed to **`nomic-embed-text` (768 dimensions)**, served by Ollama.

## Consequences
- ✅ One database, simple ops, free-tier friendly.
- ⚠️ Changing the embedding model changes the vector dimension and invalidates the index: it requires a migration plus re-embedding (or flushing the semantic cache, which is acceptable since it is a cache).
- ⚠️ Usage events grow fast; plan partitioning by month when `usage_events` passes a few million rows.
- 🔁 Revisit if semantic cache entries exceed ~10M rows or p95 lookup exceeds 20 ms.
