# 0020. Ship Grafana dashboards and alerts as file-provisioned JSON/YAML

- **Status:** Accepted
- **Date:** 2026-10-13
- **Related specs:** 011-observability, 013-deploy

## Context
Spec 011 adds dashboards (overview, cost, providers, cache) and example alert rules. They must load automatically on `docker compose up` into the `grafana/otel-lgtm` container, be reviewable in pull requests, be checked in CI against the metrics the code actually emits, and cost nothing. The same files should later be reused by the deployed demo (spec 013). Contributors (and AI agents) edit them, so the format must be easy to diff and to validate without a running Grafana.

## Options considered
1. **Grafana file provisioning: dashboard JSON + alert-rule YAML in the repo, mounted read-only into the container**: no extra tools or credentials; Grafana loads them at start; the JSON is exactly what Grafana exports, so a dashboard edited in the UI can be exported back. JSON is verbose and diffs are noisy; provisioned dashboards cannot be saved from the UI (by design, the repo is the source of truth).
2. **Grafana HTTP API pushed by a script, or the Terraform Grafana provider**: same JSON underneath plus state and drift detection; needs a running Grafana and an API token at deploy time, an extra step after `docker compose up`, and (for Terraform) a second state to manage. Better suited to a shared, long-lived Grafana than to a local stack.
3. **Generate the JSON from code (grafonnet/Jsonnet, or the Grafana Foundation SDK in TypeScript)**: reusable panel helpers and smaller diffs; adds a build step and a library to learn, and the generated JSON still has to be provisioned via option 1 or 2. Worth it for dozens of dashboards, not for four.

## Decision
We will use **option 1**: dashboards as JSON under `deploy/grafana/dashboards/`, alert rules as provisioning YAML under `deploy/grafana/alerting/`, plus the provisioning descriptors that point Grafana at them, mounted read-only into `otel-lgtm` by `docker-compose.yml`. Panels reference datasources by uid; the design records which uids `otel-lgtm` provisions (or pins them with our own datasource provisioning file if they are not stable). A Node check in `pnpm verify` validates the files and compares every PromQL metric name with the metric catalogue extracted from `src/` (spec 011 AC-8). If the dashboard count grows enough that duplication hurts, we can move to option 3 and keep option 1 as the delivery format.

## Consequences
- ✅ Zero extra tools, accounts or tokens; works offline and on the reference machine.
- ✅ Dashboards are reviewed like code and cannot drift from the metrics without CI failing.
- ⚠️ Raw dashboard JSON is verbose; reviewers should rely on the CI check and screenshots rather than reading every line.
- ⚠️ Edits made in the Grafana UI are lost unless exported back to the repo.
- 🔁 Revisit if the project needs a shared Grafana with drift detection (option 2) or more than a handful of dashboards (option 3).
