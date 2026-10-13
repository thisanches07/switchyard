# Spec 011: Observability (dashboards, alerts and GenAI conventions as code)

- **Status:** Draft
- **Owner:** @thisanches07
- **Release:** v0.3
- **Depends on:** 008 (and the metrics of 006, 007 and 009, which merge before it; see [waves](../waves.md))
- **Related ADRs:** 0010 (no prompt persistence), 0011 (OpenTelemetry), 0020 (dashboards and alerts as code, Proposed)

## Problem
Since spec 001 the gateway exports traces and metrics over OTLP to `grafana/otel-lgtm`, but an operator who runs `docker compose up` gets an **empty Grafana**: every question ("what is my error rate?", "which provider is slow?", "how much did team X spend today?", "is the cache paying off?") needs hand-written PromQL in Explore. Nothing alerts when the circuit breaker opens or usage events are dropped, and the README can only describe telemetry, not show it.

There are also three gaps in the signals themselves:
- the upstream span uses `gen_ai.system`, which the OpenTelemetry GenAI semantic conventions have **deprecated in favour of `gen_ai.provider.name`**, so GenAI-aware tools may not recognise it;
- the plan's headline metric, **gateway overhead** (the time Switchyard adds on top of the provider), is not exported, although spec 012 needs it to prove the overhead goal;
- whole-request duration and token throughput are not exported as metrics (`switchyard_upstream_duration_seconds` only measures the provider).

Dashboards and alerts must live in the repo as code, load automatically, and be checked in CI so a renamed metric cannot silently break a panel.

## User stories
- As an **operator**, I want ready-made Grafana dashboards (overview, cost, providers, cache) right after `docker compose up`, so I can see traffic, latency, errors, spend and cache savings without writing queries.
- As an **operator**, I want example alert rules for the failures that matter (high error rate, breaker open, budget near its limit, usage events dropped), so I know what to watch and can wire them to my own contact point.
- As a **maintainer**, I want CI to fail when a dashboard or alert queries a metric the code does not emit, so dashboards never rot.
- As a **performance reviewer** (spec 012), I want the gateway to export its own overhead, so benchmark numbers can be cross-checked against server-side measurements.
- As an **operator using GenAI-aware tracing tools**, I want upstream spans to follow the current OpenTelemetry GenAI conventions, still without any prompt or response content.
- As a **visitor of the repo**, I want README screenshots of the real dashboards, so I can see what the project does before running it.

## Concepts
- **Emitted metric catalogue:** the set of metric names the code registers (calls to `createCounter`, `createHistogram`, `createUpDownCounter`, `createGauge` and the observable variants under `src/`), translated to the names Prometheus in `otel-lgtm` exposes for them: histograms as `<name>_bucket`, `<name>_sum` and `<name>_count`; counters keep their `_total` name. Dashboards and alert rules may reference only names from this catalogue, plus an explicit, committed allowlist for non-Switchyard series (for example `up` or `target_info`).
- **Request duration:** time from the gateway receiving an authenticated `/v1` request to the last byte of the response (end of stream for streams), whatever the outcome.
- **Upstream time:** the sum of the durations of every upstream attempt made for the request (spec 008 may make several), each measured from sending the upstream request to its end (non-streaming) or its first chunk (streaming, see below). Retry backoff waits are **not** upstream time and **not** overhead; they are excluded from both.
- **Gateway overhead:** the time Switchyard itself adds:
  - non-streaming: `request duration − upstream time − backoff waits`;
  - streaming: measured on the first-byte path, `time to first byte sent to the client − upstream time to first chunk (summed over attempts) − backoff waits`, because after the first chunk the stream's pace is set by the provider;
  - served from cache (spec 009): the whole request duration (there is no upstream time).

## Acceptance criteria (EARS)

### Metrics
- **AC-1** THE gateway SHALL export `switchyard_request_duration_seconds` (histogram, request duration as defined above) and `switchyard_gateway_overhead_seconds` (histogram, gateway overhead as defined above) for every authenticated `/v1` request that passed admission, labelled only with low-cardinality attributes (`operation`, `stream`, `status` class and, once spec 009 has landed, `cache`), never with team, key or model identifiers beyond what `switchyard_requests_total` already carries.
- **AC-2** WHEN a unit test drives a request through the app with a fake provider of known latency (non-streaming, streaming, with one retry, and a cache hit where available), THE recorded overhead SHALL equal the request duration minus the provider's time and backoff waits within a stated tolerance, and SHALL never be negative.
- **AC-3** THE gateway SHALL export `switchyard_tokens_total{direction="input"|"output", provider, model}` incremented once per completed request with the usage recorded for it (provider-reported, else the spec 003 estimate), so that dashboard token totals match the sum of `inputTokens`/`outputTokens` in the usage events for the same requests. If an earlier spec already emits any metric of AC-1 or AC-3 under its fixed name, this spec SHALL reuse it rather than register a second instrument.

### GenAI semantic conventions on spans
- **AC-4** THE upstream span SHALL carry `gen_ai.operation.name` (`chat` or `embeddings`), `gen_ai.provider.name`, `gen_ai.request.model`, and, when known, `gen_ai.response.model`, `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus `error.type` when the call fails; it SHALL NOT emit the deprecated `gen_ai.system`, and it SHALL keep span kind `CLIENT`. THE operator's provider name from config SHALL remain available as a `switchyard.*` attribute.
- **AC-5** THE gateway SHALL NOT record prompt or response content on any span, event or log (ADR-0010): no `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` or `gen_ai.tool.definitions`, whatever the environment (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` included). A unit test SHALL assert that a request containing a sentinel string produces no span attribute containing it.

### Dashboards and alerts as code
- **AC-6** THE repository SHALL contain Grafana dashboards as JSON under `deploy/grafana/dashboards/`: **Overview** (request rate, error rate, request duration and overhead percentiles, TTFB, token throughput, rate-limit and auth rejections, usage events dropped), **Cost** (cost by team and model, requests with unknown cost, budget rejections), **Providers** (per-provider requests, errors and upstream duration, circuit state) and **Cache** (hit ratio by status, USD saved). WHEN a developer runs `docker compose up -d`, on a fresh `lgtm-data` volume and on an existing one, THE dashboards SHALL appear in Grafana without manual import, and edits to the JSON SHALL apply after a container restart.
- **AC-7** THE repository SHALL contain Grafana alert rules as code under `deploy/grafana/alerting/`, loaded automatically like AC-6, with at least: high `/v1` error rate, a circuit breaker open, a team budget near its limit, and usage events dropped. Each rule SHALL have a summary and a description saying what to check, and thresholds SHALL be documented as examples to tune, not recommendations. No contact point with real credentials SHALL be committed.
- **AC-8** WHEN `pnpm verify` runs, A check SHALL fail if any dashboard or alert file is not valid JSON/YAML, if two dashboards share a `uid`, if a panel or rule references a datasource uid other than the provisioned ones, or if any query references a metric name outside the emitted metric catalogue plus the allowlist; the failure message SHALL name the file, the panel or rule, and the unknown metric.
- **AC-9** THE Compose smoke test (`scripts/compose-smoke.ts`) SHALL, after sending traffic, query Grafana's API to confirm the four dashboards and the alert rules are provisioned, and query Prometheus to confirm that every metric referenced by the **Overview** dashboard has at least one series.

### Demo traffic and screenshots
- **AC-10** THE repository SHALL provide `pnpm demo:traffic`, a cross-platform Node script that, against a running Compose stack, creates (or reuses) a demo team and key through the admin API and sends a configurable mix of traffic for a configurable duration using the `mock` provider only: successful chat and embeddings calls, streams, repeated identical requests (cache hits where caching is enabled), forced upstream errors (`error-<status>` models) and a burst above a low rate limit. It SHALL never call a paid provider and SHALL print what it sent.
- **AC-11** THE README SHALL show screenshots of the Overview and at least one other dashboard, committed as image files and captured from a real run of the stack fed by `pnpm demo:traffic` (not mock-ups); each caption SHALL state that the data comes from the mock provider and the commit the screenshot was taken at. THE README's observability section SHALL list the new metrics, the span attributes of AC-4 and where dashboards and alerts live.

### Docs
- **AC-12** `docs/observability.md` SHALL describe each dashboard and alert rule (question it answers, metrics used, how to add a contact point), the definitions of request duration and gateway overhead, and the rule for new features: a spec that adds a metric adds its panels in the same PR, and the check of AC-8 keeps both in sync.

## Non-goals
- A hosted Grafana, Grafana Cloud setup or real alert delivery (email, Slack, PagerDuty); the deployed demo is spec 013.
- Long-term metric retention, recording rules or SLO tooling.
- Log-based dashboards, trace exemplars on panels, or a Prometheus `/metrics` scrape endpoint (OTLP stays the only export path, ADR-0011).
- Panels for metrics that are not emitted yet: features merged after this spec (for example 014 or 015) ship their own panels; anything not in the catalogue when this spec merges is out of scope (AC-8 enforces it).
- GenAI metrics from the semantic conventions (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`); the fixed `switchyard_*` names from [waves](../waves.md) remain the contract.
- Benchmark numbers (spec 012).

## Open questions
- Which value goes in `gen_ai.provider.name`, given that config provider names (`ollama`, `claude`, `mock`) are chosen by the operator while the conventions list well-known values (`openai`, `anthropic`, `groq`, `gcp.gemini`, …)? (Proposed: an optional `genAiProviderName` per provider in config; default `anthropic` for `type: anthropic` and the config name otherwise; the config name always also goes in `switchyard.provider.name`.)
- Should the upstream span be renamed from `switchyard.upstream` to the convention's `{gen_ai.operation.name} {gen_ai.request.model}` (e.g. `chat llama3.2`)? It is referenced by tests, the README and ADR-0011's stage naming. (Proposed: yes, adopt the convention name and keep a `switchyard.stage: "upstream"` attribute so Tempo searches by stage still work; update README and tests in the same PR.)
- Should the deprecated `gen_ai.system` be dual-emitted for a release for backwards compatibility? (Proposed: no; the project has no external consumers yet and the conventions are still in Development status, so ADR-0011's "revisit" clause is honoured by tracking the current names.)
- "Budget near limit" needs a utilisation signal. (Resolved: spec 007 AC-13 exports the gauge `switchyard_budget_used_ratio{scope,id}`, listed in [waves](../waves.md); the alert reads it.)
- How are screenshots captured reproducibly? (Proposed: manual capture following a checklist in `docs/observability.md` (stack up, `pnpm demo:traffic` for a fixed duration, time range "last 15 minutes"); automating with a headless browser is a later improvement.)
- Should `team` stay a label on `switchyard_requests_total` (unbounded with many teams)? (Proposed: keep it for v0.3; the Cost dashboard needs per-team views, and the demo has few teams; revisit with real tenancy.)
