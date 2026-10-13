# Spec 007: Cost accounting and monthly budgets

- **Status:** Approved (2026-10-13)
- **Owner:** @thisanches07
- **Release:** v0.1
- **Depends on:** 005, 006
- **Related ADRs:** 0006 (Redis + Lua for limits and counters), 0007 (Kafka usage events), 0017 (budget periods and cost accounting)

## Problem
Rate limits (spec 005) cap how *fast* a key spends, not how *much*. A key well inside its RPM and TPM can still run up a large provider bill over a month, and a leaked key is a "denial of wallet" attack (threat model). Since spec 006 every request is recorded with its tokens, but nothing turns tokens into money, so operators cannot see what a team costs, and nothing stops spending.

Switchyard needs:
- **cost per request**, from a versioned price table (`config/pricing.yaml`) whose missing prices stay **unknown** rather than silently becoming `$0` (CLAUDE.md: never invent prices);
- **monthly budgets** per key and per team, with a **soft limit** that warns and a **hard limit** that rejects before any provider is called;
- **real-time enforcement across gateway instances**, which means hot counters in Redis (ADR-0006), while **Postgres stays the source of truth** and a reconciliation job repairs the counters;
- a contract clients understand: OpenAI-style errors their SDKs classify correctly, and headers that tell them how much budget is left.

## User stories
- As an **operator**, I want each response and usage event to carry its cost in USD, so I can see where money goes per team, key and model.
- As an **operator**, I want to give a key or a team a monthly budget, so a runaway client or a leaked key cannot spend more than I allow.
- As an **operator**, I want a warning before the budget runs out, so I can raise it or talk to the team before requests start failing.
- As an **operator**, I want models without a verified price flagged as *unknown cost*, never counted as free, so the numbers I see are honest.
- As an **application developer**, I want a clear, non-retried error when my budget is exhausted, and headers telling me how much is left and when it resets.
- As an **operator**, I want budgets to keep being enforced correctly when Redis restarts or loses data.

## Concepts
- **Price entry:** in `config/pricing.yaml`, `models` maps a model reference to USD prices **per 1M tokens**: `input`, `output` and optional `cachedInput`, each a non-negative number or the literal `TODO` (unknown), plus optional `verifiedAt` (date) and `note`. A key is either an exact `provider/model` reference or a pattern where `*` matches any sequence of characters (including `/`), e.g. `mock/*`.
- **Priced model:** the model actually served, as the `provider/model` reference the gateway resolved (the value of `x-switchyard-provider` / `x-switchyard-model`), not the alias the client sent.
- **Known vs unknown cost:** a request's cost is *known* when every price it needs is a number; it is *unknown* (`costUsd: null`) when no entry matches or a needed price is `TODO`. Unknown cost is never treated as `0`.
- **Period:** the calendar month in UTC (ADR-0017). A request belongs to the period containing its usage event's `occurredAt` (spec 006).
- **Spend:** the sum of known costs of a key's (or a team's) requests in the current period.
- **Budget:** `monthly_budget_usd` on a key or a team (`NULL` = no budget). A request is subject to the key's budget and to its team's budget; both are checked.
- **Soft limit:** `soft_limit_pct` of the budget (team column, default `80`); a key's budget uses its team's percentage.

## Acceptance criteria (EARS)

### Prices and cost
- **AC-1** WHEN the gateway starts, THE gateway SHALL load the file at `pricingFile` and validate it (unknown fields, negative prices, values other than a number or `TODO` rejected); IF the file is missing or invalid, THEN it SHALL refuse to start with an error naming the file and the offending entry. THE gateway SHALL pick the price entry for a priced model by this precedence: an exact key match; else, among matching patterns, the one with the most non-`*` characters; else the one listed first in the file. THE gateway SHALL log one warning at boot listing every configured alias candidate whose price is unknown.
- **AC-2** WHEN an admitted request ends (the spec 006 outcome hook), THE gateway SHALL compute its cost as `(inputTokens − cachedInputTokens) × input + cachedInputTokens × cachedInput + outputTokens × output`, divided by 1 000 000, in exact decimal arithmetic rounded half-up to 10 decimal places, where `cachedInputTokens` are the provider-reported prompt-cache read tokens of the event (spec 006, a subset of `inputTokens`; unrelated to Switchyard's own response cache) priced at the entry's `cachedInput` rate when present, else at its `input` rate. A price whose token count is `0` is not needed. IF the cost is unknown, THEN `costUsd` SHALL be `null`; IF no upstream call was made, THEN `costUsd` SHALL be `"0"`. The cost SHALL use the same token counts as the event, including estimated ones (mid-stream failures and client disconnects are charged for what was generated).
- **AC-3** THE cost SHALL be exposed as: the usage event's `costUsd` (decimal string, no exponent); `switchyard_cost_usd_total{provider,model}` for known costs; `switchyard_cost_unknown_requests_total{provider,model}` for unknown ones; and, on **non-streaming** responses of admitted requests whose cost is known, the header `x-switchyard-cost-usd` (same decimal string). Streaming responses and unknown costs SHALL omit the header.

### Configuring budgets
- **AC-4** Migration `0004_budgets` SHALL add `monthly_budget_usd` (`numeric(12,4)`, `NULL` = no budget) to `api_keys` and `teams`, and `soft_limit_pct` (`integer` 1–100, default `80`) to `teams`. `POST /admin/teams` and `PATCH /admin/teams/:id` SHALL accept `monthlyBudgetUsd` and `softLimitPct`; `POST /admin/keys` and `PATCH /admin/keys/:id` SHALL accept `monthlyBudgetUsd`. `monthlyBudgetUsd` SHALL be a JSON number or decimal string ≥ `0` with at most 4 decimal places and at most `99999999.9999`, or `null` to clear; other values SHALL return `400` `invalid_request`. Responses and listings SHALL return `monthlyBudgetUsd` as a decimal string or `null` (and `softLimitPct` for teams). A change SHALL apply to new requests on the same instance immediately and on other instances within 30 s. A budget of `0` blocks every request of that key or team.
- **AC-5** THE period SHALL be the calendar month in UTC: spend SHALL reset to `0` at `00:00:00Z` on the first day of each month, and a request SHALL count toward the period of its event's `occurredAt`.

### Enforcement
- **AC-6** WHEN an authenticated `/v1` request arrives and the key's or the team's spend is greater than or equal to its `monthly_budget_usd`, THE gateway SHALL respond `429` with `{"error":{"type":"insufficient_quota","code":"budget_exceeded",…}}` (the message names the scope, `key` or `team`, and the reset time, never amounts of the other scope), the header `x-should-retry: false` and the AC-8 budget headers; it SHALL NOT call a provider, SHALL NOT debit rate-limit buckets (the budget check runs before rate limiting) and SHALL NOT emit a usage event. It SHALL count `switchyard_budget_rejections_total{scope="key"|"team"}`.
- **AC-7** THE admission check SHALL compare current spend with the budget and SHALL NOT reserve an estimated cost. Overshoot is therefore bounded: the final spend of a period SHALL NOT exceed the budget by more than the summed cost of the requests that were already admitted when spend crossed it (with one request in flight, at most that request's cost). An integration test SHALL prove the bound with concurrent requests, and the bound SHALL be documented in the budgets guide.
- **AC-8** WHEN the key or its team has a budget, THE response of every admitted request (and every `budget_exceeded` `429`) SHALL include `x-switchyard-budget-limit-usd`, `x-switchyard-budget-remaining-usd` (`max(0, limit − spend)` at admission, decimal string) and `x-switchyard-budget-reset` (ISO-8601 UTC start of the next period), describing the scope with the **lowest remaining** budget; streams SHALL send them with the first chunk's headers. Without any budget the headers SHALL be omitted.
- **AC-9** WHEN an admitted request's applicable spend is at or above `soft_limit_pct` percent of a budget but below the budget, THE gateway SHALL serve it normally, add `x-switchyard-budget-warning: soft_limit_reached`, count `switchyard_budget_soft_limit_requests_total{scope}` and log a warning at most once per scope, id and period on each instance.

### Counters and reconciliation
- **AC-10** WHEN an admitted request ends with a known cost, THE gateway SHALL add that cost to the current period's Redis counters of its key and its team (for every key and team, with or without a budget); unknown costs add nothing. THE worker SHALL, every `budgets.reconcileIntervalSeconds` (default `60`), read each key's and team's current-period spend from `usage_daily` and raise any Redis counter that is lower to that value, never lowering one (ADR-0017). After Redis loses its data, enforcement SHALL reflect the stored spend within one reconciliation interval. Counters of past periods SHALL expire.
- **AC-11** IF Redis is unreachable or errors during the budget check, THEN with `budgets.onRedisError: closed` (default, ADR-0006) THE gateway SHALL respond `503` `code: "budget_unavailable"` to requests whose key or team has a budget, and serve requests without any budget normally; with `open` it SHALL admit them, count `switchyard_budget_fail_open_total` and log a warning at most once per minute. A failure to charge a counter at the outcome hook SHALL NOT affect the response; it SHALL be counted in `switchyard_budget_charge_failures_total` and repaired by reconciliation.

### Reading budgets
- **AC-12** `GET /admin/keys/:id/budget` and `GET /admin/teams/:id/budget` (admin token) SHALL return `{ "scope", "id", "period": { "start", "end" }, "limitUsd", "softLimitPct", "spentUsd", "remainingUsd", "softLimitReached", "hardLimitReached", "unknownCostRequests", "source" }`, with money as decimal strings, `limitUsd`/`remainingUsd` `null` without a budget, `spentUsd` from the hot counter (`source: "redis"`) or, when Redis is unavailable, from `usage_daily` (`source: "postgres"`), and `404` for an unknown id. The routes SHALL appear in the OpenAPI document.

### Observability, tests and smoke
- **AC-13** THE budget check SHALL run in a `switchyard.budget` span with sanitized attributes (`switchyard.budget.scope`, `switchyard.budget.decision` = `allow`/`soft`/`reject`/`fail_open`/`fail_closed`, and the cost of the request) and no key material; all metrics in AC-3, AC-6, AC-9 and AC-11 (including `switchyard_budget_charge_failures_total`) SHALL be exported, plus a gauge `switchyard_budget_used_ratio{scope="key"|"team",id}` (current-period spend ÷ `monthly_budget_usd`, only for scopes that have a budget, may exceed `1`), updated when a counter is charged and on each reconciliation, and removed or reset when a budget is cleared or a new period starts (spec 011's "budget near limit" alert reads it).
- **AC-14** Tests SHALL cover: price precedence, `TODO` and missing entries, and cost arithmetic (unit, decimal-exact); the hard limit, the overshoot bound under concurrency, reconciliation after a Redis flush and both `onRedisError` policies (integration, real Redis and Postgres); the official OpenAI Node and Python SDKs raising `RateLimitError` on `budget_exceeded` with the HTTP status and code readable (contract). THE Compose smoke test SHALL make a request with a `mock` model and see `x-switchyard-cost-usd`, set the key's `monthlyBudgetUsd` to `0` and then see `429` `budget_exceeded`.

## Non-goals
- Real provider prices: entries stay `TODO` until someone copies them from the provider's pricing page and fills `verifiedAt`.
- Invoicing, payments, prepaid credits and currencies other than USD.
- Per-model budgets, daily or weekly periods, rolling windows and per-team custom period start days.
- Reserving an estimated cost before the call (see AC-7 and ADR-0017).
- Notifications (email, webhooks, Slack) on soft limits; alert rules belong to spec 011.
- Hot reload of `pricing.yaml` (loaded at boot; config hot reload is spec 008).
- Cache savings in USD (`switchyard_cache_savings_usd_total`, spec 009).

## Open questions
- `402` or `429` for an exhausted budget? (Proposed: `429` with `type: "insufficient_quota"`, as OpenAI does for exhausted quota, so both SDKs raise `RateLimitError`; `402` would surface as a generic `APIStatusError`. The SDKs retry `429` by default, so the response carries `x-should-retry: false`, which the OpenAI Node SDK honours (verified in `openai` 7.30's `shouldRetry`); the contract test must confirm the Python SDK does too. If it does not, Python makes its default 2 retries, which are cheap because rejection happens before any provider call.)
- What does a streaming response report as cost, since headers are sent before the cost is known and HTTP trailers are not usable by SSE clients? (Proposed: omit `x-switchyard-cost-usd` for streams; the cost is in the usage event and `GET /admin/usage`. A non-standard final SSE comment line was considered and rejected, since some clients parse every `data:` line.)
- Should a key with a hard budget be allowed to call a model whose price is unknown? (Proposed: yes, admitted and flagged: `costUsd: null`, `switchyard_cost_unknown_requests_total`, `unknownCostRequests` in the budget status and the boot warning of AC-1. A later `budgets.unknownCost: reject` option can be added through waves.md if operators want strict enforcement.)
- Should reconciliation overwrite Redis with the Postgres total or only raise it? (Proposed: only raise. Postgres lags the hot path by the pipeline delay and misses events dropped during a broker outage (ADR-0007 relies on Redis counters to keep enforcing in that case), so overwriting would erase real spend; raising still repairs the main drift, a Redis restart (Compose runs Redis without persistence). Recorded in ADR-0017.)
- Should the budget check run before or after rate limiting? (Proposed: before, so a client with an exhausted budget does not consume rate-limit units; its `429` then carries budget headers but no `x-ratelimit-*` headers.)
- Keys have no `soft_limit_pct` of their own in the shared data model. (Proposed: a key's soft limit uses its team's percentage; add `api_keys.soft_limit_pct` later through waves.md if needed.)
- Which budget do the headers describe when both the key and the team have one? (Proposed: the scope with the lowest remaining amount, mirroring the "most restrictive bucket" rule of spec 005.)
