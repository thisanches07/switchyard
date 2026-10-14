# Benchmarks

Spec [012](specs/012-benchmarks/spec.md) · Method: [ADR-0021](adr/0021-benchmark-methodology.md)

Switchyard makes two measurable promises, stated here as **targets to verify, not claims**:

- **T1**: the gateway adds little latency: p95 overhead **below 15 ms** with a mock provider and no cache.
- **T2**: it survives a failing provider: with the primary failing **30 %** of the time, at least **99 %** of requests still succeed.

The [Results](#results) section and the README table are **generated** by `pnpm bench:report` from the raw results committed under `bench/results/`; `pnpm verify` fails if either differs from what the generator produces, so no number can be typed by hand. A missed target is published as measured, with a GitHub issue.

## Scenarios

| Scenario | What it does | Compared with | Reports |
|---|---|---|---|
| `no-cache` | Non-streaming chat through auth, rate limit and budget; both caches **off**; key limits too high to trip | direct baseline | latency, client- and server-side overhead, **T1** |
| `exact-cache` | Identical `temperature: 0` requests to a gateway with the exact cache **on** | | latency of cache hits, hit ratio from `x-switchyard-cache` |
| `streaming` | SSE streams; the mock spaces chunks by 20 ms | direct baseline | time to first byte and total stream time, TTFB overhead |
| `rate-limited` | Load above a 60 rpm key's limit | | admitted vs the limit, every `429` well formed with `retry-after`, rejection latency |
| `chaos` | Alias whose primary fails 30 % of requests, secondary healthy | | client-visible success rate, **T2** |

## Method

The full rationale is in [ADR-0021](adr/0021-benchmark-methodology.md); in short:

- **Upstream.** A mock upstream (`bench/mock-upstream/`) serves the gateway's own `mock` provider over HTTP as an OpenAI-compatible API: 50 ms before answering, 20 ms between streamed chunks, and a second instance that fails 30 % of requests with `503`. The gateway reaches it through its `openai-compatible` adapter, exactly like a real provider, so the numbers measure **the gateway**, not a model. Nothing benchmark-only ships in the gateway image.
- **Stack.** `pnpm bench` builds the gateway from the production `Dockerfile` and starts the usual Compose stack (Postgres, Redis, Redpanda, usage worker, OpenTelemetry to `grafana/otel-lgtm`), plus the mocks and a second gateway with the exact cache enabled, under its own Compose project with fresh volumes.
- **Load generator.** k6 from a pinned image (`grafana/k6`, tag and digest in `bench/bench.config.json`), in a container on the Compose network of the **same host**. There is no second machine, so k6, the gateway and the mock share the CPUs.
- **Arrival model.** k6 `constant-arrival-rate` (open model): requests arrive at a fixed rate whatever the response time, which avoids coordinated omission (a slow gateway cannot lower its own load). Rates are below the direct baseline's saturation; if k6 reports dropped iterations the run is marked **not valid**.
- **Phases.** Each scenario has a 30 s warm-up (JIT, connection pools, auth cache, Redis scripts) whose samples are excluded, then a 120 s steady phase that is measured. Rates and durations are in ADR-0021 and `bench/bench.config.json`; their hash is recorded in every run.
- **Baseline.** For `no-cache` and `streaming`, the same request shape and rate is first sent **directly** to the mock upstream in the same run, then through the gateway.
- **Overhead, two ways, both published.** Client-side: the gateway's p50/p95/p99 minus the direct baseline's (a difference of percentiles, not the percentile of per-request differences); T1 uses this one, because it includes everything a client experiences. Server-side: `switchyard_gateway_overhead_seconds` (spec 011) over the steady window, read from Prometheus. When the two disagree by more than 5 ms at p95, the report says so.
- **Repetitions.** A published measurement is at least three runs of the same commit; the report shows every run and marks the median (by T1).
- **Correctness first.** Speed never fails a run; correctness does (exit code non-zero, marked in the report): an unexpected status (anything but `200`, plus `429` in `rate-limited` and well-formed `502/503/504` in `chaos`), a malformed body or SSE stream, a missing `x-switchyard-*` header, or more admitted requests than the rate limit allows.

### Known limitations
- **Same host, no isolation.** Docker Desktop runs every container in one WSL2 VM whose vCPUs Windows schedules alongside everything else: there is no CPU pinning. k6 competes with the gateway; the paired baseline cancels part of this, not all. Numbers describe the stated machine, not production.
- **Difference of percentiles** approximates per-request overhead and can disagree with it in the tail; the server-side histogram is the cross-check.
- **Server-side window.** The gateway exports metrics every 15 s, so the Prometheus window can include up to one export interval of warm-up, and histogram buckets make low-millisecond quantiles coarse.
- **Exact-cache** responses must carry `x-switchyard-cache: hit|miss` (spec 009); the first requests are misses, so its latency percentiles mix a few misses with the hits, and the hit ratio is published next to them.
- **Server-side labels.** The scenarios run one after the other, so the Prometheus window, not a per-gateway label, separates them; selectors use spec 011's `operation`, `stream`, `status` and `cache` labels (`cache="hit"` for `exact-cache`, `status="2xx"` for `rate-limited`, since rejected requests are never admitted).

## Running it

Prerequisites: Docker (Desktop on Windows, Engine on Linux), Node 24, pnpm (`corepack enable`), `pnpm install`. The bench stack uses the dev stack's host ports (8080, 55432, 6379, 19092, 3000, 4317, 4318) plus 9090 for Prometheus, so stop the dev stack first (`docker compose down`).

```bash
pnpm bench                              # every scenario, full profile
pnpm bench -- --scenario no-cache       # one scenario (comma-separate for several)
pnpm bench -- --smoke                   # short correctness-only variant (what CI runs)
pnpm bench -- --keep                    # leave the stack running afterwards
pnpm bench:report                       # regenerate the tables below and the README's
```

The command starts the stack, creates a team and keys through the admin API, runs each scenario (direct pass first where there is a baseline), collects the server-side metrics, writes the run folder and runs `docker compose down -v` on the bench project. It exits non-zero on any correctness or harness error.

**Run folder** `bench/results/<run-id>/` (clean full runs) or `bench/results/local/<run-id>-smoke|-dirty/` (git-ignored, never published):

| File | Content |
|---|---|
| `environment.json` | CPU model and cores, RAM, OS, Docker version and the CPUs/memory available to it, Node, k6 version and image digest, gateway and mock image ids, git commit and dirty flag, config hash, publishability |
| `k6/<scenario>.<direct\|gateway>.json` | raw k6 summary of each pass |
| `server-metrics.json` | server-side overhead per scenario, with the PromQL used (or why it is missing) |
| `run.json` | scenario outcomes, steady windows, k6 exit codes, problems |
| `bench.config.json` | the parameters the run used |
| `summary.md` | human-readable summary of this run |

**CI** runs `pnpm bench -- --smoke` (job `bench-smoke`) on pull requests that touch `bench/`, `src/` or the `Dockerfile`. It fails only on correctness and harness errors; shared runners are too noisy to publish, so its numbers stay in the job log.

## Reading the results
- Each run table shows, per scenario, p50/p95/p99 and the achieved request rate of the steady phase through the gateway, the same for the direct baseline, the client-side overhead, the server-side overhead, and the ok / not-ok counts (failed plus rejected).
- `n/a` or "not available" means the value was not measured (for example a server-side quantile with no series in the window); it is never shown as zero.
- **Valid: no** means k6 could not keep the arrival rate (load generator saturated); such a run is published but does not count as a measurement of the gateway.
- Targets show the measured value next to **met** or **missed**; a miss links its issue, or says an issue is still required.

## Publishing a run (reference machine)

The reference machine is the documented target environment (Windows 10, Docker Desktop on WSL2, 4 cores, 16 GB RAM). Checklist:

1. Check out `main` with a clean tree (`git status` shows nothing), stop the dev stack, close heavy applications, keep the machine on mains power.
2. `pnpm install --frozen-lockfile`.
3. Run `pnpm bench` **three times**. Each clean run writes `bench/results/<run-id>/`. Keep every run folder; a run that ended with a harness error before any scenario ran (for example a port in use) measured nothing and may be deleted. Never drop a run because of its numbers.
4. `pnpm bench:report` and review the generated tables in this file and the README.
5. For each missed target, open a GitHub issue labelled `performance` with the run id and the evidence (the run's `summary.md`), add its link to `bench/target-issues.json`, and run `pnpm bench:report` again.
6. `pnpm verify`, then commit the run folders, `bench/target-issues.json` and the regenerated tables (`docs(bench): publish benchmark runs [spec-012]`) and open a PR.

Changing the methodology (scenario shape, rates, durations, what is subtracted) requires amending ADR-0021 first and rerunning **all** scenarios.

## Results
<!-- bench:results:start -->
<!-- Generated by `pnpm bench:report` from bench/results/. Do not edit by hand. -->

**No published run yet.** The harness is in place, but no clean benchmark run from the reference machine has been committed under `bench/results/`, so there are no results to show and the targets have not been evaluated.

| Target | Measured | Status |
| --- | --- | --- |
| T1: p95 gateway overhead below 15 ms (`no-cache`, client-side) | not measured | not evaluated |
| T2: at least 99 % success with a primary failing 30 % of the time (`chaos`) | not measured | not evaluated |
<!-- bench:results:end -->
