# Spec 005: Rate limiting (requests and tokens per minute)

- **Status:** Draft (review, then change to Approved)
- **Owner:** @thisanches07
- **Release:** v0.1
- **Depends on:** 004
- **Related ADRs:** 0006 (Redis + Lua for limits and counters), 0008 (no retry after first byte), 0011 (OpenTelemetry)

## Problem
Since spec 004 every caller is identified by a key and a team, but nothing stops one of them from sending thousands of requests or millions of tokens per minute. One runaway script, a retry loop or a leaked key can exhaust the operator's provider quota (providers rate-limit the *operator's* account, so one tenant's burst becomes everyone's 429s) and degrade every other team. Unknown keys also still reach Postgres on every attempt, so a flood of bad keys is a cheap way to load the database.

Switchyard needs limits that are:
- **per key and per team**, in **requests per minute (RPM)** and **tokens per minute (TPM)**, the units providers and the OpenAI API use;
- **shared across gateway instances** (a global count in Redis, not a per-process counter);
- **atomic** (no over-admission under concurrency) and cheap enough for the hot path (one Redis round trip);
- **visible to clients** through the same `x-ratelimit-*` headers and `429` responses the OpenAI SDKs already understand, so their built-in backoff just works.

Tokens are the hard part: the real count is only known *after* the provider answers. The gateway therefore **reserves** an estimate before the call and **reconciles** with the real usage afterwards.

## User stories
- As an **operator**, I want to give each key and each team an RPM and TPM limit, so a single client cannot exhaust the shared provider quota.
- As an **operator**, I want sensible defaults for keys that have no explicit limit, so a newly issued key is never unlimited by accident.
- As an **application developer**, I want standard `429` responses with `retry-after` and `x-ratelimit-*` headers, so the OpenAI SDK's retry logic handles limits without custom code.
- As an **operator**, I want the gateway to keep serving if Redis goes down (by default), and to know when that happens.
- As an **operator**, I want repeated invalid-key attempts from one address to be throttled before they reach Postgres.

## Concepts
- **Bucket:** a token bucket per *(scope, id, kind)*, e.g. *(key, 9f…, requests)*. Capacity = the per-minute limit; it refills continuously at `limit / 60` units per second. A request is admitted only if **every** applicable bucket has enough units, and then all of them are debited **in one atomic Redis operation**.
- **Effective limits:**
  - key RPM / TPM = the key's own value, else `limits.defaults` from config, else unlimited;
  - team RPM / TPM = the team's own value, else unlimited (team limits are opt-in caps across all of a team's keys).
- **Token reservation:** before calling the provider, the gateway debits an estimate of the request's tokens from the TPM buckets; afterwards it refunds or charges the difference against the real usage.

## Acceptance criteria (EARS)

### Configuring limits
- **AC-1** THE schema SHALL store optional `rpm` and `tpm` (positive integers, `NULL` = not set) on both `api_keys` and `teams` via a new migration, and the config file SHALL accept `limits.defaults.rpm`, `limits.defaults.tpm` (optional) and `limits.completionReserveTokens` (default `512`).
- **AC-2** WHEN an operator creates a key or team, THE admin API SHALL accept optional `rpm`/`tpm`; WHEN an operator sends `PATCH /admin/keys/:id` or `PATCH /admin/teams/:id` with `rpm`/`tpm` (a number, or `null` to clear), THE change SHALL apply to new requests on the same instance immediately and on other instances within 30 s.

### Request limits
- **AC-3** WHEN an authenticated `/v1` request arrives, THE gateway SHALL atomically take 1 unit from the key's and the team's request buckets; IF any of them is empty, THEN it SHALL respond `429` with `{"error":{"type":"requests","code":"rate_limit_exceeded",…}}`, SHALL NOT debit any bucket, and SHALL NOT call a provider.
- **AC-4** THE request buckets SHALL refill continuously at `limit / 60` per second up to `limit`, so a key with `rpm: 60` that exhausts its bucket can make about one request per second afterwards.

### Token limits
- **AC-5** WHEN a chat or embeddings request is admitted, THE gateway SHALL reserve `estimate = ceil(input characters / 4) + completion allowance` from the key's and team's token buckets in the same atomic operation as AC-3, where the completion allowance is `max_completion_tokens`, else `max_tokens`, else `limits.completionReserveTokens` (and `0` for embeddings). IF a token bucket cannot cover the estimate, THEN it SHALL respond `429` with `type: "tokens"`. A single request whose estimate exceeds the bucket capacity SHALL be rejected with `400` `code: "request_too_large_for_limit"` instead of waiting forever.
- **AC-6** WHEN the provider call finishes, THE gateway SHALL reconcile the reservation against the real usage (provider-reported, else the spec 003 estimate): refunding the unused part or debiting the excess (a bucket may go below zero, delaying later requests). WHEN the call fails before any tokens are produced, THE full token reservation SHALL be refunded; the request unit is never refunded. For streams, reconciliation SHALL happen when the stream ends, fails mid-stream or the client disconnects.

### Client-facing contract
- **AC-7** EVERY authenticated `/v1` response (success or `429`) SHALL include `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens` and `x-ratelimit-reset-tokens`, reporting the **most restrictive** applicable bucket in the OpenAI format (reset as a duration such as `1s` or `6m0s`); headers for an unlimited dimension SHALL be omitted. `429` responses SHALL also include `retry-after` in whole seconds (at least 1).
- **AC-8** WHEN the official OpenAI Node and Python SDKs (with retries disabled) hit a limit, THEY SHALL raise `RateLimitError`; with default retries, a request that becomes admissible within the SDK's backoff SHALL eventually succeed.

### Correctness and resilience
- **AC-9** WHEN several gateway instances share one Redis, THE limits SHALL be global: with `rpm: 10` and 50 concurrent requests spread across two instances, exactly 10 SHALL be admitted.
- **AC-10** IF Redis is unreachable or the script errors, THEN with `limits.onRedisError: open` (default) THE gateway SHALL admit the request, count it in `switchyard_ratelimit_fail_open_total` and log a warning at most once per minute; with `closed` it SHALL respond `503` `code: "rate_limiter_unavailable"`.
- **AC-11** WHEN requests with a missing, malformed or unknown key come from one client address, THE gateway SHALL allow at most `limits.authFailuresPerMinutePerIp` (default `30`) such failures per minute and then respond `429` without querying Postgres, until the bucket refills. Valid keys from the same address are unaffected.

### Observability
- **AC-12** THE gateway SHALL record `switchyard_ratelimit_rejections_total{scope="key"|"team"|"ip", kind="requests"|"tokens"}`, add `switchyard.ratelimit.*` attributes (scope and kind of a rejection, tokens reserved and reconciled) to the request span, and never log key material.

### Tests and smoke
- **AC-13** Integration tests SHALL exercise the Lua script on a real Redis (Testcontainers): atomic multi-bucket debit, refill over time, reconciliation, concurrency (AC-9) and the Redis-down policy.
- **AC-14** THE Compose smoke test SHALL create a key with `rpm: 2` and observe `200`, `200`, then `429` with `retry-after` and `x-ratelimit-*` headers.

## Non-goals
- Per-model or per-provider limits, and daily or monthly quotas (budgets are spec 007).
- Exact tokenisation (tiktoken and friends): estimates plus reconciliation are enough for limiting; exact cost accounting arrives with usage events (spec 006).
- Queueing or delaying requests instead of rejecting them.
- Limits on the admin API.
- Retries or fallback to another provider on an upstream 429 (spec 008).

## Open questions
- Should the headers describe the key's own limits or the most restrictive applicable bucket? (Proposed: the most restrictive, so a client throttled by its team limit still sees why.)
- Which client address identifies a caller for AC-11 behind a reverse proxy? (Proposed: the socket address by default; `server.trustProxy: true` makes Fastify use `X-Forwarded-For`, to be set only behind a trusted proxy.)
- Should keys without explicit limits default to unlimited? (Proposed: no; the example config sets `limits.defaults` to `rpm: 60`, `tpm: 100000`, which operators can raise or remove.)
