# 0017. Account costs as exact decimals per calendar month (UTC) and enforce budgets without cost reservation

- **Status:** Accepted
- **Date:** 2026-10-13
- **Related specs:** 006-usage-pipeline, 007-budgets

## Context
Spec 007 adds a cost to every request and monthly budgets per key and team. Several choices are entangled and easy to get subtly wrong:

- **Period.** "Monthly" needs a precise boundary that every gateway instance, the worker and Postgres agree on, independent of server time zones.
- **Representation.** Per-request costs are tiny (one token at $0.10 per 1M tokens is $0.0000001) and are summed millions of times. Binary floating point accumulates rounding error and prints values like `1e-7`, which JSON clients and spreadsheets mishandle.
- **Unknown prices.** `config/pricing.yaml` marks unverified prices `TODO`, and CLAUDE.md forbids inventing prices. Treating unknown as `0` would make expensive models look free and silently disable budgets for them.
- **Enforcement.** The real cost of a request is only known after the provider answers. Spec 005 solved the same problem for tokens with a reservation that is reconciled afterwards; budgets could copy that or simply check the spend so far.
- **Hot counters vs source of truth.** ADR-0006 keeps budget counters in Redis (`INCRBYFLOAT`) for the hot path with Postgres as the source of truth. Postgres is fed asynchronously through Kafka (ADR-0007), so it lags, and it misses events dropped during a long broker outage. The local Redis runs without persistence, so counters vanish on restart.

## Options considered
1. **Period**
   - **Calendar month in UTC**: simple, matches provider invoices, one boundary for everyone. Teams in other time zones see the reset at a local time other than midnight.
   - **Rolling 30 days**: smooth, but "how much is left" changes continuously and needs per-day history in the hot path.
   - **Per-team billing anchor day / time zone**: flexible, but more columns, more tests, and no current need.
2. **Representation**
   - **Exact decimals end to end**: `numeric` in Postgres, decimal arithmetic in the gateway (fixed scale), decimal strings on the wire. Correct; slightly more code than `number`.
   - **Floats everywhere**: trivial, but drifting sums and exponent notation in APIs.
   - **Integer micro-dollars**: exact and fast, but $0.000001 is too coarse for per-token prices and the unit leaks into every API.
3. **Enforcement**
   - **Check spend so far, no reservation**: one read before the call, one increment after. Overshoot is possible but bounded.
   - **Reserve an estimated cost, reconcile later** (like spec 005 TPM): tighter bound, but needs a price lookup and a token estimate before the call, refunds on every failure path, and gives wrong answers whenever the estimate (especially output length) is off.
4. **Reconciliation**
   - **Overwrite Redis with the Postgres total**: Postgres is authoritative, but it lags the hot path and lacks dropped events, so every overwrite erases real recent spend.
   - **Raise Redis to the Postgres total, never lower it**: repairs lost counters (Redis restart, flush, expiry) without erasing spend Postgres has not seen yet.

## Decision
- **Periods are calendar months in UTC.** A request belongs to the month of its usage event's `occurredAt` (the end of the request, spec 006). Counters are keyed by period, so a new month starts at `0` without a reset job; past-period counters expire.
- **Costs are exact decimals.** The gateway computes `tokens × price per 1M / 1 000 000` in decimal arithmetic, rounded half-up to 10 decimal places. Postgres stores costs as `numeric` (`usage_events.cost_usd` and `usage_daily.cost_usd` with scale 10; budgets as `numeric(12,4)`). APIs, headers and usage events carry costs as **decimal strings without exponent** (e.g. `"0.0000030000"`); admin inputs accept a JSON number or a decimal string. The only floating-point value is the Redis hot counter (`INCRBYFLOAT`), which is used for admission decisions only and whose drift is bounded by reconciliation; reported spend in `usage_daily` never goes through a float.
- **Unknown prices are never zero.** If no price entry matches, or a price needed by the request is `TODO`, the cost is `null` (unknown). Unknown costs are counted separately (`unknown_cost_requests`, `switchyard_cost_unknown_requests_total`), not added to spend, and reported next to spend wherever spend is shown. A request that reached no provider costs exactly `0`.
- **Budgets are enforced without cost reservation.** Admission rejects a request when the current spend is greater than or equal to the budget; the request's cost is added after it ends. **Overshoot bound:** the final spend of a period exceeds the budget by at most the summed cost of the requests already admitted when spend crossed the budget, i.e. one request's cost per request in flight at that moment. Operators who need a tighter cap set the budget lower by that margin, or cap concurrency with spec 005 limits.
- **Reconciliation only raises counters.** Every `budgets.reconcileIntervalSeconds` the worker sets each current-period Redis counter to `max(redis, postgres)`. Postgres remains the source of truth for reporting; Redis remains the (possibly higher) enforcement view.

## Consequences
- ✅ Reported costs add up exactly; no `1e-7` in JSON; one unambiguous reset instant.
- ✅ Models without verified prices cannot masquerade as free; the gap is visible in metrics and in the budget status.
- ✅ Admission costs one Redis read and no price estimate; no refund paths to get wrong.
- ✅ A Redis restart or flush is repaired within one reconciliation interval, and events dropped during a broker outage keep counting toward enforcement (as ADR-0007 assumes).
- ⚠️ Budgets can be overshot by the in-flight requests at the moment of crossing; with long, expensive streams this can be noticeable.
- ⚠️ Requests to unknown-price models are not limited by budgets at all.
- ⚠️ A Redis counter that is wrongly high (e.g. a bug double-charging) is not corrected by reconciliation; fixing it needs an operator action (deleting the counter lets reconciliation rebuild it from Postgres).
- ⚠️ Calendar months in UTC reset at a local time other than midnight for teams outside UTC.
- 🔁 Revisit if real billing is built on top (then add an outbox, ADR-0007, and consider overwriting counters with a lag watermark), if overshoot matters in practice (add a cost reservation), or if teams need their own period anchors.
