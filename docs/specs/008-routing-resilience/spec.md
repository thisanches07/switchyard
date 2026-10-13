# Spec 008: Routing strategies, retries, circuit breakers and config hot reload

- **Status:** Draft
- **Owner:** @thisanches07
- **Release:** v0.1
- **Depends on:** 003, 006 (and the pricing module of 007 for `lowest-cost`, see Open questions)
- **Related ADRs:** 0003 (OpenAI-compatible API), 0004 (canonical format, retryable error classes), 0008 (no retry after first byte), 0011 (OpenTelemetry), 0017 (budget periods and cost accounting), 0018 (config hot reload, Proposed)

## Problem
Aliases already list several candidates (`fast: [groq/…, gemini/…, ollama/…]`), but the gateway only ever calls the first one (`src/modules/routing/resolve.ts`). The `strategy` field, the `retry` and `circuitBreaker` sections and `server.timeouts.totalMs` are accepted by the config schema and then ignored, so:
- one upstream hiccup (a 503, a dropped connection, a provider-side 429) becomes a client-facing error, even when another configured candidate would have answered;
- a provider that is down keeps receiving every request and every client waits for its timeouts;
- `lowest-cost` and `lowest-latency` aliases behave exactly like `priority`;
- changing a candidate list or a threshold needs a restart, which drops in-flight streams.

Switchyard needs routing that hides transient upstream failures from clients **without** ever splicing two answers into one stream (ADR-0008), that stops hammering a failing candidate, and that can be reconfigured while serving traffic.

## User stories
- As an **application developer**, I want a request to an alias to succeed when one of its candidates fails before answering, so transient provider errors do not reach my users.
- As an **application developer**, I want to see which provider and model actually served my request and how many attempts it took, so I can debug latency and quality differences.
- As an **operator**, I want a failing candidate to be taken out of rotation automatically and probed back in, so a provider outage does not add its timeouts to every request.
- As an **operator**, I want `lowest-cost` and `lowest-latency` aliases that order candidates by price and by measured latency.
- As an **operator**, I want to change aliases, candidates and resilience settings without restarting the gateway, and a broken config file must never take the gateway down.
- As an **operator**, I want an admin view of each candidate's breaker state, latency and recent error rate.

## Concepts
- **Candidate:** one `provider/model` reference. An alias has the candidates listed in its config; a request for a plain `provider/model` has exactly one candidate.
- **Eligible candidate:** a candidate the requesting key may use (allowed-models check, spec 004) and whose circuit breaker admits a call (closed, or half-open with no probe in flight).
- **Attempt:** one upstream call to one candidate. A **client request** may make several attempts; it has exactly one rate-limit admission (spec 005), one budget admission (spec 007) and one usage event (spec 006).
- **Retryable failure:** a failure that happened **before any response data was forwarded to the client** and is one of: a connection error (refused, reset, DNS, connect timeout), a timeout before the first byte, an upstream `408`, `429` or any `5xx`. Every other upstream `4xx` is **non-retryable**: it is the client's request that is wrong, and another candidate would most likely reject it too.
- **Circuit breaker:** per candidate, with states `closed` (calls allowed), `open` (calls skipped) and `half-open` (exactly one probe call allowed). Breaker and latency state live in memory in each gateway instance.
- **EWMA latency:** per candidate, `ewma = alpha × sample + (1 − alpha) × ewma`, where `alpha = routing.ewmaAlpha` and the sample is the latency of a successful attempt up to its response (non-streaming) or its first chunk (streaming). A candidate with no sample yet is **cold**.

## Acceptance criteria (EARS)

### Candidate selection
- **AC-1** WHEN a `/v1/chat/completions` or `/v1/embeddings` request names an alias, THE gateway SHALL treat each of the alias's candidates as eligible only if the key's allowed models match the alias name, the candidate's `provider/model` or its `provider/*` (the spec 004 rule, applied per candidate after alias resolution); IF no candidate passes this check, THEN it SHALL respond `403` `code: "model_not_allowed"` without calling a provider. THE config file SHALL accept `routing.ewmaAlpha` (`0 < alpha ≤ 1`, default `0.3`) and `routing.hotReload` (boolean, default `true`).
- **AC-2** THE gateway SHALL order eligible candidates by the alias's strategy: `priority` in config order; `lowest-cost` by ascending estimated request cost (spec 005 token estimate × the candidate's input and output prices from the spec 007 pricing module), with candidates whose price is unknown (`TODO` or missing) placed **after** all priced candidates in config order, and ties kept in config order; `lowest-latency` with **cold candidates first** (in config order, so each one gets measured), then by ascending EWMA latency.

### Retries and fallback
- **AC-3** WHEN an attempt fails with a retryable failure, THE gateway SHALL make the next attempt on the next eligible candidate in the order of AC-2, wrapping around to the first candidate when the list is exhausted (so a single-candidate route retries the same candidate), until `retry.maxAttempts` attempts **in total across all candidates** have been made; IF an attempt fails with a non-retryable `4xx`, THEN it SHALL return that error to the client at once, with no further attempts.
- **AC-4** WHEN the next attempt goes to a candidate already tried in this client request, THE gateway SHALL wait a full-jitter backoff `random(0, min(retry.maxDelayMs, retry.baseDelayMs × 2^(k−1)))` before it, where `k` is the number of attempts made so far; WHEN that candidate's failed response carried `Retry-After`, the wait SHALL be at least that value capped at `retry.maxDelayMs`. An attempt on a candidate not yet tried SHALL start without delay.
- **AC-5** WHEN all attempts fail, THE gateway SHALL return the last attempt's error in the OpenAI shape (`502 upstream_error`, `504 upstream_timeout` or the upstream `429`); WHEN the client disconnects, THE gateway SHALL stop making attempts.

### Streaming (ADR-0008)
- **AC-6** WHEN a streaming request fails before its first chunk has been written to the client, THE gateway SHALL retry and fall back exactly as for non-streaming requests, and the client SHALL receive one well-formed stream from the candidate that succeeded, with no content from failed attempts. AFTER the first chunk has been written, THE gateway SHALL NOT retry or fall back: a failure SHALL end the stream with an OpenAI-style error event, the usage event SHALL have `outcome: "upstream_error_midstream"`, and the failure SHALL count against that candidate's breaker.

### Timeouts
- **AC-7** THE gateway SHALL apply `server.timeouts.connectMs` to establishing each attempt's connection and `server.timeouts.ttfbMs` to each attempt's wait for response headers (and, once a stream flows, to the gap between chunks, as in spec 003). `server.timeouts.totalMs` SHALL bound the **whole client request across all attempts and backoff waits**, up to the complete response (non-streaming) or the first chunk (streaming); IF the remaining budget is shorter than the next backoff wait, THEN THE gateway SHALL stop and return the last error, and IF the budget runs out during an attempt, THEN it SHALL respond `504 upstream_timeout`.

### Circuit breaker
- **AC-8** WHEN a candidate has `circuitBreaker.failureThreshold` consecutive failed attempts (retryable failures and mid-stream failures; non-retryable `4xx` and client disconnects do not count), ITS breaker SHALL open and the candidate SHALL be skipped by every request for `circuitBreaker.openMs`; THEN it SHALL become half-open and admit exactly **one** probe attempt (concurrent requests skip it); a successful probe (response received, or first chunk for streams) SHALL close the breaker and reset the count, and a failed probe SHALL reopen it for another `openMs`.
- **AC-9** IF every candidate that passed the allowed-models check has an open breaker (or a half-open breaker with a probe in flight) when a request needs an attempt, THEN THE gateway SHALL respond `503` `{"error":{"type":"server_error","code":"no_healthy_upstream",…}}` with `retry-after` set to the whole seconds (at least 1) until the earliest breaker becomes half-open, without calling any provider.

### Client contract and accounting
- **AC-10** EVERY response to a routed request (success or error, streaming or not) SHALL carry `x-switchyard-provider` and `x-switchyard-model` of the candidate that **served** it (or of the last candidate attempted, on error; omitted when no attempt was made) and `x-switchyard-attempts` with the number of attempts made (`0` for AC-9). THE usage event SHALL report the same candidate in `provider`/`servedModel` and the count in `attempts`. THE request SHALL be admitted by the rate limiter and the budget check **once**, and reconciled once against the usage and cost of the attempt that served it; failed attempts SHALL add no tokens and no cost.

### Admin and hot reload
- **AC-11** WHEN an operator calls `GET /admin/providers/health` with the admin token, THE gateway SHALL return, for every candidate known to this instance, its breaker state, consecutive failures, the time the breaker becomes half-open (if open), EWMA latency in ms (`null` when cold) with its sample count, and the error rate over its last 100 attempts, stating that the view is per instance.
- **AC-12** WHILE `routing.hotReload` is `true`, WHEN the config file's content changes, THE gateway SHALL validate it and, if valid, apply it to **new** requests within 5 s (ADR-0018); `POST /admin/config/reload` SHALL do the same on demand and report whether the config changed, and on Linux `SIGHUP` SHALL trigger a reload too. Requests already in flight SHALL finish with the config they started with. Breaker and EWMA state SHALL survive a reload for every candidate whose `provider/model` and provider definition are unchanged, and be reset or dropped otherwise. Settings fixed at startup (`server.bodyLimitBytes`, `server.trustProxy`) SHALL keep their old values, with a warning that they need a restart.
- **AC-13** IF a reloaded file is not valid YAML or fails schema validation, THEN THE gateway SHALL keep serving with the previous config, log the validation issues (paths and messages, never secret values), count it in `switchyard_config_reloads_total{result="failure"}`, and `POST /admin/config/reload` SHALL respond `400` `code: "invalid_config"` with the issues; successful reloads SHALL count as `result="success"`.

### Observability
- **AC-14** THE gateway SHALL export `switchyard_circuit_state{candidate}` (`0` closed, `1` half-open, `2` open) and `switchyard_upstream_attempts_total{candidate,outcome}` (`success`, `retryable_error`, `non_retryable_error`, `timeout`, `midstream_error`), log every breaker transition once, and record each attempt as a child span of the request span with the candidate, attempt number, outcome and the backoff waited, never with prompt or response content (ADR-0010).

### Tests and smoke
- **AC-15** A chaos integration test SHALL route an alias of three mock candidates, each with `errorRate: 0.3`, `retry.maxAttempts: 5` and a fixed random seed (for upstream failures and backoff jitter alike), through N = 1000 requests sent sequentially (half of them streaming) and observe **at least 990** successful responses, no stream containing content from more than one attempt, and identical results on every run with the same seed.
- **AC-16** THE Compose smoke test SHALL call an alias whose first candidate always fails before responding (mock `error-503`) and observe `200` with `x-switchyard-attempts: 2` and `x-switchyard-model` naming the second candidate.

## Non-goals
- Breaker, EWMA or retry state shared across gateway instances (each instance learns on its own).
- Hedged or parallel requests to several candidates at once.
- Retrying or resuming a stream after its first chunk (ADR-0008).
- Content-aware routing (by prompt length, language, tools) and per-key routing overrides.
- Retrying non-retryable `4xx`, such as a context-length error, on another candidate.
- Hot reload of environment variables, of the pricing file (spec 007) or of settings fixed at startup.
- Active health checks that call providers outside client traffic.

## Open questions
- `lowest-cost` needs the pricing module of spec 007, which is drafted in parallel in wave B. What if 007 is not merged yet? (Proposed: `waves.md` merges 007 before 008 inside wave B, so 008 builds on the real pricing module. If 007 slips, 008 merges with `lowest-cost` treating every price as unknown, which by AC-2 means config order, and the `lowest-cost` ordering test is enabled in the PR that lands the pricing module.)
- Should breaker state be shared through Redis? (Proposed: no. Per-instance state needs no extra round trip and each instance stops hammering a dead provider after `failureThreshold` failures of its own; revisit if many instances make the total probe traffic noticeable.)
- Should streaming TTFB and non-streaming latency feed separate EWMAs? (Proposed: one EWMA per candidate for v0.1; split it if `lowest-latency` aliases mix streaming and non-streaming traffic badly in practice.)
- A cold-first rule measures every candidate once, but a slow candidate is only re-measured when the faster ones fail. Is periodic exploration needed? (Proposed: not in v0.1; add an exploration share as an optional `routing` field later if EWMA staleness shows up.)
- Should an upstream `429` open the breaker? (Proposed: yes, it counts as a failure: a provider that rate-limits the operator's account is better skipped for `openMs` than hit again by every request.)
- Should a `Retry-After` longer than `retry.maxDelayMs` skip that candidate instead of waiting the capped time? (Proposed: wait the capped time on a retry of the same candidate; when another untried candidate exists, AC-3/AC-4 already move to it without waiting.)
