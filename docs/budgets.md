# Costs and monthly budgets

Spec [007](specs/007-budgets/spec.md) · decisions in [ADR-0017](adr/0017-budget-periods-and-cost-accounting.md).

## Prices

`config/pricing.yaml` (the `pricingFile` setting) maps a model to USD prices **per 1M tokens**:

```yaml
models:
  ollama/llama3.2:      { input: 0, output: 0, verifiedAt: 2026-10-09 }
  mock/*:               { input: 1.0, output: 2.0, note: "synthetic prices for tests" }
  claude/claude-sonnet-5-5: { input: TODO, output: TODO, cachedInput: TODO }
```

- A key is an exact `provider/model`, or a pattern where `*` matches anything (including `/`). Precedence: exact key, then the pattern with the most non-`*` characters, then the first one listed.
- `TODO` means **unknown**. Switchyard never invents prices: copy them from the provider's pricing page and set `verifiedAt`. The gateway logs one warning at boot listing the alias candidates whose price is unknown.
- `cachedInput` prices the provider's prompt-cache reads (`cachedInputTokens`, part of the input tokens); without it they cost the `input` price.
- The file is validated at boot (unknown fields, negative prices and strings other than `TODO` are rejected, naming the entry) and is not hot-reloaded.

## Cost of a request

```
cost = ((input − cached) × input price + cached × cachedInput price + output × output price) / 1 000 000
```

computed in exact decimal arithmetic and rounded half-up to 10 decimal places, with the same token counts as the usage event (estimated ones included: a stream cut mid-way is charged for what was generated). The priced model is the one actually served (`x-switchyard-provider` / `x-switchyard-model`), not the alias.

| Case | `costUsd` |
|---|---|
| Every needed price known | e.g. `"0.0000140000"` |
| No entry, or a needed price is `TODO` | `null` (unknown, never `0`) |
| No provider was called (e.g. PII `block`) | `"0"` |

Where it shows up: the usage event (`costUsd`), `GET /admin/usage`, the metrics `switchyard_cost_usd_total{provider,model}` and `switchyard_cost_unknown_requests_total{provider,model}`, and the header `x-switchyard-cost-usd` on **non-streaming** responses with a known cost (stream headers leave before the cost is known).

## Budgets

```bash
ADMIN="Authorization: Bearer $ADMIN_TOKEN"
# A team: $200 a month, warn at 90 %
curl -s -X PATCH localhost:8080/admin/teams/$TEAM -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"monthlyBudgetUsd": 200, "softLimitPct": 90}'
# One of its keys: $25 a month ("25" works too; null removes the budget)
curl -s -X PATCH localhost:8080/admin/keys/$KEY -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"monthlyBudgetUsd": "25"}'
```

- **Period:** the calendar month in UTC. Spend resets at `00:00:00Z` on the 1st; a request counts in the month its usage event occurred.
- **Scopes:** a request is checked against its key's budget and its team's budget. A key uses its team's `softLimitPct` (default 80).
- **Hard limit:** when spend ≥ budget, the request gets `429` before any provider is called, without using rate-limit units or producing a usage event:

  ```json
  {"error":{"type":"insufficient_quota","code":"budget_exceeded",
            "message":"Monthly budget exhausted for this key. It resets at 2026-11-01T00:00:00.000Z."}}
  ```

  with `x-should-retry: false`, which the official OpenAI SDKs honour (they raise `RateLimitError` and do not retry). A budget of `0` blocks every request.
- **Soft limit:** at `softLimitPct` % of a budget, requests are still served and carry `x-switchyard-budget-warning: soft_limit_reached`; each instance logs one warning per scope and month.
- **Headers:** whenever the key or its team has a budget, every admitted response (and every `budget_exceeded`) carries the scope with the **lowest remaining** budget:

  | Header | Example |
  |---|---|
  | `x-switchyard-budget-limit-usd` | `25` |
  | `x-switchyard-budget-remaining-usd` | `3.75` |
  | `x-switchyard-budget-reset` | `2026-11-01T00:00:00.000Z` |

- **Changes** apply to the next request on the instance that received them, and on other instances within 30 s (the auth cache).
- **Unknown prices are not limited:** a model with a `TODO` price is served and counted in `unknownCostRequests`, but adds nothing to spend. Fill its price to bring it under budgets.

### Overshoot bound

The check compares the spend *so far* with the budget; it does not reserve an estimated cost (ADR-0017), because the real cost is only known when the provider answers. Requests already running when spend crosses the budget still finish and are charged. Therefore:

> The final spend of a month exceeds the budget by at most the summed cost of the requests that were in flight when spend crossed it. With one request at a time, by at most that one request.

Example: a $10 budget, spend at $9.90, and three requests of $0.50 admitted concurrently: all three are served, spend ends at $11.40, and every later request is rejected. If that margin matters, set the budget lower by the cost of your expected concurrency, or cap concurrency with per-minute rate limits (spec 005). `test/integration/budgets.int.test.ts` proves the bound with concurrent requests on real Redis.

## How it works

- **Hot counters in Redis** (ADR-0006): `sy:budget:{YYYY-MM}:{key|team}:{id}`, increased with `INCRBYFLOAT` when a request ends (for every key and team, budget or not) and expiring a week after their month. Admission reads them with one `MGET`, only for keys or teams that have a budget.
- **Postgres is the source of truth:** `usage_daily.cost_usd` (exact `numeric`), fed by the usage pipeline (spec 006).
- **Reconciliation:** every `budgets.reconcileIntervalSeconds` (default 60) the usage worker raises each current-month counter to the stored spend, **never lowering one** (Postgres lags and misses events dropped during a broker outage). After a Redis restart or flush, enforcement reflects the stored spend within one interval. A counter that is wrongly high is not lowered: delete it and reconciliation rebuilds it.

## When Redis is down

| `budgets.onRedisError` | Requests with a budget | Requests without |
|---|---|---|
| `closed` (default) | `503 budget_unavailable` | served normally |
| `open` | served without budget headers; `switchyard_budget_fail_open_total`, a warning at most once a minute | served normally |

A failure to charge a counter when a request ends never affects the response; it is counted in `switchyard_budget_charge_failures_total` and repaired by reconciliation.

## Checking a budget

```bash
curl -s localhost:8080/admin/keys/$KEY/budget -H "$ADMIN" | jq
```

```json
{
  "scope": "key", "id": "0c9b8a7d-…",
  "period": { "start": "2026-10-01T00:00:00.000Z", "end": "2026-11-01T00:00:00.000Z" },
  "limitUsd": "25", "softLimitPct": 90, "spentUsd": "21.25", "remainingUsd": "3.75",
  "softLimitReached": false, "hardLimitReached": false,
  "unknownCostRequests": 3, "source": "redis"
}
```

`GET /admin/teams/:id/budget` is the same for a team. `spentUsd` comes from the Redis counter (`source: "redis"`), or from `usage_daily` when Redis is unavailable (`source: "postgres"`).

## Metrics

| Metric | Labels |
|---|---|
| `switchyard_cost_usd_total` | `provider`, `model` |
| `switchyard_cost_unknown_requests_total` | `provider`, `model` |
| `switchyard_budget_rejections_total` | `scope` |
| `switchyard_budget_soft_limit_requests_total` | `scope` |
| `switchyard_budget_fail_open_total` | |
| `switchyard_budget_charge_failures_total` | |
| `switchyard_budget_used_ratio` (gauge, may exceed 1) | `scope`, `id` |

The budget check runs in a `switchyard.budget` span (`switchyard.budget.scope`, `switchyard.budget.decision` = `allow` / `soft` / `reject` / `fail_open` / `fail_closed`); request spans carry `switchyard.cost_usd`.
