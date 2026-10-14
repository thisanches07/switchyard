# 0011. Use OpenTelemetry as the single telemetry API

- **Status:** Accepted
- **Date:** 2026-10-09
- **Related specs:** 001, 011

## Context
We need traces, metrics and correlated logs from day one, locally and in the deployed demo, without locking into a vendor.

## Options considered
1. **OpenTelemetry SDK → OTLP → `grafana/otel-lgtm` locally / Grafana Cloud free tier in the demo**: vendor-neutral, one container for local dev.
2. **`prom-client` + separate tracing library**: familiar, but two APIs and no single correlation story.
3. **Vendor SDK (Datadog, New Relic)**: great UX, paid, lock-in.

## Decision
Use the **OpenTelemetry Node SDK** with auto-instrumentation for HTTP, undici, pg and ioredis, plus manual spans for pipeline stages (`auth`, `ratelimit`, `budget`, `pii`, `cache`, `route`, `upstream`). Export via **OTLP** to `grafana/otel-lgtm` locally. Logs use **pino** with `trace_id`/`span_id` injected. Span attributes follow OpenTelemetry GenAI semantic conventions where they exist (`gen_ai.*`), and never include content (ADR-0010). Dashboards are versioned under `deploy/grafana/dashboards`.

> Update (spec 011, 2026-10-13): the upstream stage span is named after the GenAI conventions (`{gen_ai.operation.name} {gen_ai.request.model}`) and carries `switchyard.stage: "upstream"` so searches by stage still work; `gen_ai.system` was replaced by `gen_ai.provider.name`. See [docs/observability.md](../observability.md).

## Consequences
- ✅ One API for traces, metrics and logs; easy switch of backends.
- ⚠️ Instrumentation has overhead; it is included in the benchmark numbers, not hidden.
- 🔁 Revisit if GenAI semantic conventions change materially.
