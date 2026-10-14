# Tasks 012: Benchmarks

- **Status:** In progress (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-012]`. Lint, typecheck and the task's tests before each commit; full `pnpm verify` at the end. Docker, k6 and `pnpm bench` are validated by the CI `bench-smoke` job, not locally. All tests below are under `test/unit/bench/`.

- [x] **T1. Mock upstream server**
  - ACs: AC-1
  - Do: `bench/mock-upstream/server.ts`, `main.ts`, `tsconfig.json`, `Dockerfile`; root `tsconfig.json` includes `bench`.
  - Test: `mock-upstream.test.ts` › config from env and flags; latency honoured; errors injected at the configured rate within tolerance (seeded random, and through the real `openai-compatible` provider); chunks spaced by the delay; SSE parsed by the gateway's adapter; `error-<status>` and `error-midstream`; embeddings and health.

- [x] **T2. Benchmark config and bench stack**
  - ACs: AC-2, AC-3
  - Do: `bench/bench.config.json`, `bench/config/gateway.yaml`, `gateway-cache.yaml`, `bench/compose.bench.yml`, `bench/lib/config.ts`; ADR-0021 parameters section.
  - Test: `bench-config.test.ts` › both gateway configs parse with `parseConfig` and differ only in `cache.exact.enabled`; every scenario has full and smoke parameters; k6 image pinned by tag and digest; config hash stable and sensitive to changes.

- [x] **T3. k6 checks and scenarios**
  - ACs: AC-3, AC-4
  - Do: `bench/k6/validate.js` (+ `.d.ts`), `bench/k6/lib.js`, one script per scenario.
  - Test: `validate.test.ts` › chat body, SSE stream (good, truncated, malformed, no `[DONE]`), error body, required gateway headers, cache header classification; expected content matches the mock provider.

- [x] **T4. Evaluation: statistics, overhead, targets, rate-limit bound**
  - ACs: AC-4, AC-7, AC-8
  - Do: `bench/lib/k6-summary.ts`, `bench/lib/evaluate.ts`.
  - Test: `evaluate.test.ts` › summary extracted between markers; percentiles and achieved rate; client overhead as a difference of percentiles; T1/T2 met, missed and not evaluated; rate-limit bound; dropped iterations flagged.

- [x] **T5. Environment and run folder**
  - ACs: AC-5
  - Do: `bench/lib/environment.ts`, `bench/lib/args.ts`.
  - Test: `environment.test.ts` › run id; dirty and smoke runs not publishable and routed to `results/local`; Docker info and image digests shaped. `args.test.ts` › `--scenario`, `--smoke`, `--keep`, bare `--`, unknown scenario.

- [x] **T6. Server-side overhead collector**
  - ACs: AC-7
  - Do: `bench/lib/metrics.ts`.
  - Test: `metrics.test.ts` › PromQL for each quantile and the count with the configured selector and window; Prometheus vector parsed to ms; empty result → `null` with "metric not exported".

- [x] **T7. Report generator and published tables**
  - ACs: AC-6, AC-7, AC-8, AC-9
  - Do: `bench/lib/runs.ts`, `bench/lib/render.ts`, `bench/report.ts`, `bench/target-issues.json`, markers in `docs/benchmarks.md` and README; fixtures in `test/fixtures/bench/`.
  - Test: `render.test.ts` › no runs → "No published run yet" and no digits in the tables; fixture runs: T1/T2 met and missed, issue link or "issue required", server overhead "not available", median of a batch, batch under three runs noted, smoke/dirty/fixture runs excluded; `published-tables.test.ts` › committed docs and README sections equal the generator's output.

- [x] **T8. Orchestrator `pnpm bench`**
  - ACs: AC-2, AC-5
  - Do: `bench/run.ts`, `bench/lib/plan.ts`, `package.json` scripts, `.gitignore`.
  - Test: `run-plan.test.ts` › scenario plan (direct before gateway for `no-cache` and `streaming`; k6 env per pass); k6 exit codes mapped to correctness vs harness errors. End to end: CI `bench-smoke`.

- [x] **T9. CI benchmark smoke**
  - ACs: AC-10
  - Do: `.github/workflows/bench-smoke.yml`.
  - Test: CI job `bench-smoke` on a PR touching `bench/`, `src/` or `Dockerfile`.

- [x] **T10. Docs**
  - ACs: AC-11
  - Do: `docs/benchmarks.md` (methodology, how to run, how to read, publish checklist), README benchmark section and quality gates.
  - Test: `published-tables.test.ts` (generated parts unchanged).

### Blocked (finish after the dependencies merge)

- [x] **T11. Exact-cache hit ratio (spec 009 merged; end-to-end check is the PR's CI smoke)**
  - ACs: AC-3 (`exact-cache`), AC-4
  - Do: set `requireCacheHeader` to `true` for `exact-cache` in both profiles of `bench/bench.config.json` once 009's `x-switchyard-cache` header is on `main`; confirm the CI smoke records hits after the first miss.
  - Test: CI `bench-smoke` with `REQUIRE_CACHE_HEADER=true`; `validate.test.ts` › cache header classification (already in place).

- [x] **T12. Server-side overhead from `switchyard_gateway_overhead_seconds` (spec 011 merged; selectors use its `operation`, `stream`, `status`, `cache` labels; end-to-end check is the PR's CI smoke)**
  - ACs: AC-7
  - Do: align `serverMetrics.selectors` in `bench/bench.config.json` with 011's final labels and the Prometheus job label of each gateway; confirm the CI smoke's `server-metrics.json` has non-null quantiles.
  - Test: `metrics.test.ts` (in place); CI `bench-smoke` log shows the server-side overhead rows.

- [ ] **T13. Published run on the reference machine (needs the owner's machine)**
  - ACs: AC-5..AC-9, AC-11
  - Do: follow the publish checklist in `docs/benchmarks.md`: clean tree on `main`, `pnpm bench` three times, commit the three `bench/results/<run-id>/` folders, `pnpm bench:report`, open an issue for any missed target and link it in `bench/target-issues.json`, `pnpm bench:report` again, commit.
  - Test: `published-tables.test.ts` with the committed runs.
