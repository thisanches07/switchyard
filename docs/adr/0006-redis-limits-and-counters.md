# 0006. Use Redis with Lua scripts for rate limits, budget counters and the exact cache

- **Status:** Proposed
- **Date:** 2026-10-09
- **Related specs:** 005, 007, 009

## Context
Rate limiting and budget checks run on every request and must be atomic across multiple gateway instances, with sub-millisecond cost.

## Options considered
1. **Redis + Lua scripts**: atomic check-and-update in one round trip, horizontally safe, well-known patterns (token bucket / sliding window).
2. **In-memory per instance**: fastest, but wrong as soon as there are two instances.
3. **Postgres counters**: durable but too slow and contention-prone for the hot path.

## Decision
Use **Redis** (Valkey-compatible) via `ioredis`. Rate limits use a **token bucket in a Lua script** for RPM and TPM. TPM is reserved up front (estimated input tokens + `max_tokens`) and reconciled after the response. Budgets use `INCRBYFLOAT` hot counters, with **Postgres as the source of truth** and a reconciliation job (spec 007). The exact-match response cache also lives in Redis with TTL.

## Consequences
- ✅ Correct across instances, one round trip per check.
- ⚠️ Redis becomes a hot-path dependency. Policy when Redis is down: **fail open for rate limits, fail closed for hard budgets**, both visible in metrics. This is configurable.
- ⚠️ Counters can drift from Postgres; reconciliation bounds the drift.
- 🔁 Revisit if Redis latency shows up in the overhead budget.
