# Tasks 011: Observability (dashboards, alerts and GenAI conventions as code)

- **Status:** In progress
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-011]`. T13 and T14 are blocked on things outside this branch.

- [x] **T1. Metric catalogue and Grafana file check**
  - ACs: AC-8
  - Do: `scripts/lib/metric-catalogue.ts` (scan `src/`, OTLP→Prometheus name translation), `scripts/lib/grafana-check.ts` (JSON/YAML, uids, datasources, PromQL metric names), `scripts/check-grafana.ts`, `deploy/grafana/metrics-allowlist.json`, `pnpm check:grafana` in `pnpm verify`; cost counter unit `{USD}` (design §8.1).
  - Test: `test/unit/scripts/metric-catalogue.test.ts` › translation (seconds kept, `_total`, `_ratio`, braces, `USD` case), real catalogue has the fixed names; `test/unit/scripts/grafana-check.test.ts` › invalid JSON/YAML, duplicate uid, unknown datasource, unknown metric names file + panel + metric, nested rows, templating, rules, allowlist, PromQL functions/labels ignored.
  - Files: `scripts/**`, `deploy/grafana/metrics-allowlist.json`, `package.json`, `src/modules/budgets/telemetry.ts`

- [ ] **T2. GenAI semantic conventions on the upstream span**
  - ACs: AC-4
  - Do: span name `{operation} {model}`, `gen_ai.provider.name`, `switchyard.provider.name`, `switchyard.stage`, `error.type`; drop `gen_ai.system`; optional `genAiProviderName` per provider; update tests that look spans up by name.
  - Test: `test/unit/proxy/telemetry.test.ts` › GenAI attributes and name, error.type, no gen_ai.system, default and configured provider name; `test/unit/config/schema.test.ts` › genAiProviderName.
  - Files: `src/modules/proxy/{telemetry,attempts,routes}.ts`, `src/config/schema.ts`, `config/switchyard.example.yaml`, `test/unit/**`

- [ ] **T3. No prompt or response content in telemetry**
  - ACs: AC-5
  - Test: `test/unit/proxy/no-content-telemetry.test.ts` › sentinel absent from every span attribute, span event and log line (chat, stream, embeddings, messages), with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`.
  - Files: test only (fix code if it fails)

- [ ] **T4. Request duration and gateway overhead**
  - ACs: AC-1, AC-2
  - Do: `RequestTiming` + `gatewayOverheadMs`; attempt and backoff times in `runAttempts`; first byte in `streamChat`; tracker `onEnd`; histograms with bucket advice (also upstream duration and TTFB); high-resolution `systemTimers.now()`.
  - Test: `test/unit/proxy/timing.test.ts` › formula, streams use first byte, clamp at 0, records once after both end and outcome; `test/unit/proxy/request-metrics.test.ts` › non-streaming, streaming, one retry with backoff (manual clock, exact), labels only operation/stream/status, not recorded before admission.
  - Files: `src/modules/proxy/{timing,telemetry,attempts,routes,stream}.ts`, `src/modules/usage/outcome.ts`, `src/modules/routing/timers.ts`

- [ ] **T5. Token counter and zero-initialised drop counter**
  - ACs: AC-3, AC-9 (series exist)
  - Test: `test/unit/usage/token-metrics.test.ts` › tokens_total by direction/provider/model equals the usage events' sums through the app; `test/unit/usage/telemetry.test.ts` › dropped counter exported at 0 per reason.
  - Files: `src/modules/usage/{token-metrics,telemetry}.ts`, `src/app.ts`

- [ ] **T6. Grafana provisioning and the Overview dashboard**
  - ACs: AC-6, AC-8
  - Do: provisioning descriptor, compose mounts, `overview.json`.
  - Test: `test/unit/scripts/grafana-files.test.ts` › repo files pass the check; Overview has the AC-6 panels; compose mounts the three paths read-only.
  - Files: `deploy/grafana/**`, `docker-compose.yml`

- [ ] **T7. Cost and Providers dashboards, Cache skeleton**
  - ACs: AC-6
  - Test: `grafana-files.test.ts` › four dashboards with unique uids; Cost and Providers panels.
  - Files: `deploy/grafana/dashboards/{cost,providers,cache}.json`

- [ ] **T8. Alert rules**
  - ACs: AC-7
  - Test: `grafana-files.test.ts` › four rules (error rate, circuit open, budget near limit, events dropped), summary + description, thresholds documented as examples, no contact points.
  - Files: `deploy/grafana/alerting/switchyard-alerts.yaml`

- [ ] **T9. Compose smoke step**
  - ACs: AC-9
  - Do: after the traffic steps, query Grafana for the four dashboards and the rules, and Prometheus (via the Grafana datasource proxy) for every Overview metric; retries up to 60 s. Runs in CI only.
  - Test: `scripts/compose-smoke.ts` step (CI); `test/unit/scripts/grafana-check.test.ts` › `overviewMetrics()` lists the Overview metric names.
  - Files: `scripts/compose-smoke.ts`, `scripts/lib/grafana-check.ts`

- [ ] **T10. `pnpm demo:traffic`**
  - ACs: AC-10
  - Do: `scripts/lib/traffic-plan.ts` (pure mix plan), `scripts/demo-traffic.ts` (admin API team/key reuse, mock-only, prints a summary).
  - Test: `test/unit/scripts/traffic-plan.test.ts` › proportions, only `mock/*` refs, forced errors, repeats, burst, duration and rate parsing.
  - Files: `scripts/**`, `package.json`

- [ ] **T11. Docs**
  - ACs: AC-11 (text), AC-12
  - Do: `docs/observability.md` (dashboards, alerts, contact point, definitions, rule for new metrics, screenshot checklist); README observability section (new metrics, span attributes, where dashboards/alerts live, screenshot captions template); `docs/architecture.md`; ADR-0011 stage naming note.
  - Files: docs, README

- [ ] **T12. Verification**
  - ACs: all
  - Do: `pnpm verify`, `pnpm test:int` (if touched), contract tests; AC → test table below.

- [ ] **T13. Screenshots** — *blocked: needs a working local stack (owner)*
  - ACs: AC-11
  - Do: follow the checklist in `docs/observability.md` § Screenshots; commit `docs/assets/dashboard-overview.png` and one more; fill in the commit hash in the README captions.

- [ ] **T14. Cache dashboard panels** — *blocked until spec 009 merges*
  - ACs: AC-6 (Cache), AC-1 (`cache` label)
  - Do: hit ratio by status (`switchyard_cache_lookups_total{layer,result}`), USD saved (`switchyard_cache_savings_usd_total`), unknown savings, cache errors by layer/stage, requests by `cache`; `cache` label on the duration/overhead histograms; check passes with the real catalogue.
  - Test: `grafana-files.test.ts` › Cache panels; `request-metrics.test.ts` › cache hit overhead equals duration.
