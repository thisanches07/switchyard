# Observability

Switchyard exports traces and metrics over OTLP ([ADR-0011](adr/0011-opentelemetry.md)) to the `grafana/otel-lgtm` container of the Compose stack (Grafana, Prometheus, Tempo, Loki). Dashboards and example alert rules live in this repository and load automatically ([ADR-0020](adr/0020-dashboards-and-alerts-as-code.md), [spec 011](specs/011-observability/spec.md)). No prompt or response content is ever recorded ([ADR-0010](adr/0010-no-prompt-persistence.md)).

```bash
docker compose up -d          # Grafana on http://localhost:3000 (admin / admin)
pnpm demo:traffic             # 5 minutes of mock-only traffic so the panels have data
```

Open **Dashboards → Switchyard**.

## Where things live

| Path | What |
|---|---|
| `deploy/grafana/dashboards/*.json` | Overview, Cost, Providers, Cache (Grafana dashboard JSON) |
| `deploy/grafana/alerting/switchyard-alerts.yaml` | Alert rule group `switchyard` (Grafana file provisioning) |
| `deploy/grafana/provisioning/dashboards/switchyard.yaml` | Dashboard provider: folder `Switchyard`, read from `/otel-lgtm/switchyard/dashboards` |
| `deploy/grafana/metrics-allowlist.json` | Non-Switchyard series dashboards may query (`up`, `target_info`) |
| `docker-compose.yml` (`lgtm`) | Mounts the three paths read-only, outside the `lgtm-data` volume |

Provisioned dashboards cannot be saved from the Grafana UI. To change one: edit it in Grafana, **Export → Export as JSON**, replace the file in `deploy/grafana/dashboards/`, run `pnpm check:grafana`, then `docker compose restart lgtm` (Grafana also re-reads the folder every 30 s). The same works on a fresh and on an existing `lgtm-data` volume, because nothing is stored in it.

## Definitions

- **Request duration** (`switchyard_request_duration_seconds`): from the gateway receiving an authenticated `/v1` request to the last byte of the response (end of stream for streams), whatever the outcome. Recorded for every request that passed admission (rate limit and budget); requests rejected before (401, 404, 429 from limits) are counted in their own metrics instead.
- **Upstream time**: the sum of the durations of every attempt made for the request (spec 008 may make several), each from sending the upstream request to its end, or to its first chunk for streams.
- **Gateway overhead** (`switchyard_gateway_overhead_seconds`): the time Switchyard itself adds.
  - Non-streaming: request duration − upstream time − retry backoff waits.
  - Streaming: time to the first byte sent to the client − upstream time to the first chunk − backoff waits (after the first chunk the provider sets the pace). A stream that fails before its first chunk uses the non-streaming formula.
  - Served from cache (spec 009): the whole duration (there is no upstream time).
  - Never negative. All terms are read from one clock (`performance.timeOrigin + performance.now()`, sub-millisecond).

Both histograms are labelled only by `operation` (`chat`, `embeddings`, `messages`), `stream` (`true`, `false`) `status` class (`2xx`, `4xx`, `5xx`) and `cache` (`hit`, `semantic_hit`, `miss`, `bypass`, spec 009).

## Metrics

| Metric | Type | Labels | Source |
|---|---|---|---|
| `switchyard_request_duration_seconds` | histogram | `operation`, `stream`, `status` | spec 011 |
| `switchyard_gateway_overhead_seconds` | histogram | `operation`, `stream`, `status` | spec 011 |
| `switchyard_tokens_total` | counter | `direction` (`input`, `output`), `provider`, `model` (`none` without an upstream) | spec 011; equals the usage events' token sums |
| `switchyard_requests_total` | counter | `provider`, `model`, `status`, `team` | spec 002/004 |
| `switchyard_upstream_duration_seconds`, `switchyard_ttfb_seconds` | histogram | `provider`, `model` (+ `outcome`) | spec 002/003 |
| `switchyard_upstream_attempts_total`, `switchyard_circuit_state`, `switchyard_config_reloads_total` | counter, gauge, counter | `candidate`, `outcome` / `result` | spec 008 |
| `switchyard_ratelimit_rejections_total`, `switchyard_ratelimit_fail_open_total` | counter | `scope`, `kind` (rejections) | spec 005 |
| `switchyard_auth_failures_total` | counter | `reason` | spec 004 |
| `switchyard_usage_events_dropped_total`, `_published_total`, `switchyard_usage_buffer_events`, `switchyard_usage_worker_events_total` | counters, gauge | `reason` / `result` | spec 006 |
| `switchyard_cost_usd_total`, `switchyard_cost_unknown_requests_total` | counter | `provider`, `model` | spec 007 |
| `switchyard_budget_rejections_total`, `_soft_limit_requests_total`, `_fail_open_total`, `_charge_failures_total`, `switchyard_budget_used_ratio` | counters, gauge | `scope` (+ `id`) | spec 007 |
| `switchyard_pii_detections_total` | counter | `type` | spec 010 |
| `switchyard_cache_lookups_total`, `switchyard_cache_errors_total`, `switchyard_cache_savings_usd_total`, `switchyard_cache_savings_unknown_total` | counter | `layer` + `result` / `stage` / `model`, `team` | spec 009 |

Histogram buckets are explicit (seconds): duration `0.005 … 120`, overhead `0.0001 … 1`. `switchyard_usage_events_dropped_total` starts at 0 for every reason, so a healthy stack shows 0 rather than "no data".

**Names in Prometheus.** Prometheus's OTLP receiver appends the unit to a metric name unless the name already contains it (case-sensitive), so units that are not real units are written in braces (`{USD}`, `{token}`): `switchyard_cost_usd_total` stays `switchyard_cost_usd_total` instead of `switchyard_cost_usd_USD_total`.

## Upstream span

One span per upstream attempt, kind `CLIENT`, named after the [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai): `{gen_ai.operation.name} {gen_ai.request.model}` (e.g. `chat llama3.2`).

| Attribute | Value |
|---|---|
| `gen_ai.operation.name` | `chat` or `embeddings` (`/v1/messages` is `chat`) |
| `gen_ai.provider.name` | `genAiProviderName` from the provider's config; default `anthropic` for `type: anthropic`, the config name otherwise |
| `gen_ai.request.model`, `gen_ai.response.model` | requested candidate model, provider-reported model |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | when known (`switchyard.usage.estimated: true` when estimated) |
| `error.type` | on failure: the gateway error code (`upstream_error`, `upstream_timeout`, …) |
| `switchyard.stage` | `upstream` (search Tempo by stage: `{ span.switchyard.stage = "upstream" }`) |
| `switchyard.provider.name`, `switchyard.provider.type` | config name and adapter type |
| `switchyard.candidate`, `.attempt`, `.attempt.outcome`, `.backoff_ms`, `.ttfb_ms`, `.team_id`, `.key_id` | routing and tenancy metadata |

`gen_ai.system` (deprecated) is not emitted. Content attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`) are never recorded, whatever `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` says; a unit test sends a sentinel string through every route and checks every span, span event and log line.

## Dashboards

| Dashboard | Question it answers | Metrics |
|---|---|---|
| **Overview** (`switchyard-overview`) | Is the gateway healthy, how fast is it, and how much does it add? Request rate by status class, 5xx ratio, request duration and overhead p50/p95/p99, TTFB, token throughput, rate-limit and auth rejections, usage events dropped | `switchyard_request_duration_seconds_*`, `switchyard_gateway_overhead_seconds_bucket`, `switchyard_requests_total`, `switchyard_ttfb_seconds_bucket`, `switchyard_tokens_total`, `switchyard_ratelimit_rejections_total`, `switchyard_auth_failures_total`, `switchyard_usage_events_dropped_total` |
| **Cost** (`switchyard-cost`) | What are we spending, on which models, which teams send the traffic, and who is near a budget? | `switchyard_cost_usd_total`, `switchyard_cost_unknown_requests_total`, `switchyard_requests_total{team}`, `switchyard_budget_*` |
| **Providers** (`switchyard-providers`) | Which provider is slow or failing, how often do we retry, and which breakers are open? | `switchyard_requests_total`, `switchyard_upstream_duration_seconds_bucket`, `switchyard_ttfb_seconds_bucket`, `switchyard_upstream_attempts_total`, `switchyard_circuit_state` |
| **Cache** (`switchyard-cache`) | Is the cache paying off? Hit ratio, requests by cache status, hit ratio and lookups by layer, USD saved by model and team, hits with an unknown price, cache errors by layer and stage | `switchyard_requests_total{cache}`, `switchyard_cache_lookups_total`, `switchyard_cache_savings_usd_total`, `switchyard_cache_savings_unknown_total`, `switchyard_cache_errors_total` |

Cost per team is not a Prometheus query: `switchyard_cost_usd_total` is labelled by provider and model only (spec 007). The Cost dashboard shows each team's share of requests; exact spend per team comes from `GET /admin/usage?groupBy=team`.

## Alert rules

Rule group `switchyard` in folder **Switchyard**, evaluated every minute. **Thresholds are examples to tune for your traffic, not recommendations.** Each rule has a `summary` and a `description` saying what to check.

| Rule | Fires when (example) | What to check |
|---|---|---|
| `switchyard-high-error-rate` | more than 5 % of admitted `/v1` requests are 5xx, for 5 min | Providers dashboard, `upstream request failed` logs, `GET /admin/providers/health` |
| `switchyard-circuit-open` | any candidate's breaker is open (`switchyard_circuit_state` = 2), for 1 min | Circuit state panel, breaker transition logs, `GET /admin/providers/health` |
| `switchyard-budget-near-limit` | any key or team above 90 % of its monthly budget, for 5 min | Budget used panel, `GET /admin/teams/{id}/budget` |
| `switchyard-usage-events-dropped` | any usage event dropped in the last 5 min | Redpanda health, gateway logs, `switchyard_usage_buffer_events` |

### Adding a contact point

No contact point or notification policy is committed (alerts go to Grafana's default policy, which delivers nowhere until you add one). To get notified locally:

1. Grafana → **Alerting → Contact points → Add contact point** (email, Slack webhook, …). Credentials stay in Grafana's database in the `lgtm-data` volume, never in this repo.
2. **Alerting → Notification policies**: point the default policy (or a policy matching `service = switchyard`) at it.

To manage contact points as code in your own deployment, add a provisioning file next to `switchyard-alerts.yaml` that reads secrets from environment variables (`$__env{SLACK_WEBHOOK_URL}`), and keep it out of git.

## Rule for new features

A spec that adds a metric adds its dashboard panels (and, if it matters, an alert rule) **in the same PR**. `pnpm check:grafana` (part of `pnpm verify`) keeps both in sync: it fails when a dashboard or rule is invalid JSON/YAML, when two dashboards share a `uid`, when a panel or rule uses a datasource other than the provisioned ones (`prometheus`, `tempo`, `loki`, `pyroscope`, plus `__expr__` for rule expressions), or when a query references a metric the code does not emit. The emitted catalogue is read from the `create*("name", { unit })` calls under `src/` and translated to Prometheus names (histograms as `_bucket`/`_sum`/`_count`, counters ending in `_total`, units appended as above). The error names the file, the panel or rule, and the metric. Series that are not Switchyard's go in `deploy/grafana/metrics-allowlist.json`.

The Compose smoke test (`pnpm test:smoke`, CI) checks that Grafana lists the four dashboards and the four rules, and that every metric of the Overview dashboard has at least one series after its traffic.

## Demo traffic

`pnpm demo:traffic [--duration 300] [--rps 4] [--mix chat=8,stream=4,embeddings=2,repeat=3,error=1,burst=0.25]` against a running stack (`DEMO_GATEWAY_URL`, default `http://localhost:8080`; `ADMIN_TOKEN`, default the Compose dev token). It reuses (or creates) the team `demo-traffic`, creates a key for the run (or uses `DEMO_API_KEY`) plus a key limited to 3 requests per minute for the burst, checks that `mock/*` really is the built-in mock provider (only its `echo` model answers with the prompt), then sends:

| Kind | Requests |
|---|---|
| `chat`, `stream` | `mock/demo` completions, streamed with usage for `stream` |
| `embeddings` | `mock/embed` |
| `repeat` | the same chat request every time (cache hits where caching is enabled) |
| `error` | `mock/error-500`, `-503`, `-429`, `-400` and `mock/error-midstream` |
| `burst` | 6 requests at once on the limited key (some get 429) |

It never calls a paid provider and prints a count per kind and status at the end.

## Screenshots

The README shows real screenshots of the dashboards, not mock-ups. To capture or refresh them:

1. `git status` is clean; note the commit: `git rev-parse --short HEAD`.
2. `docker compose up -d --build`, and wait until <http://localhost:3000> loads.
3. `pnpm demo:traffic --duration 900` (15 minutes; keep it running while you capture).
4. In Grafana (light theme, browser window 1600 × 1000), open **Switchyard / Overview**, time range **Last 15 minutes**, refresh off; wait for every panel to render. Capture the dashboard area as PNG.
5. Repeat for **Switchyard / Providers** (and **Cost** if you like).
6. Save as `docs/assets/dashboard-overview.png` and `docs/assets/dashboard-providers.png` (keep each under ~400 KB, e.g. with `pngquant`).
7. Update the captions in the README's Observability section: *"Grafana, Overview dashboard, fed by `pnpm demo:traffic` (mock provider). Captured at commit `<hash>`."*
