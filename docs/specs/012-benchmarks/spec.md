# Spec 012: Benchmarks (k6, measured overhead, published honestly)

- **Status:** Draft
- **Owner:** @thisanches07
- **Release:** v0.3
- **Depends on:** 009, 011
- **Related ADRs:** 0008 (no retry after first byte), 0011 (OpenTelemetry), 0021 (benchmark methodology, Proposed)

## Problem
The plan makes two measurable promises: the gateway adds **little latency** (target: p95 overhead under 15 ms with a mock provider and no cache) and it **survives a failing provider** (target: with the primary failing 30% of the time, at least 99% of requests still succeed). Neither has been measured. `docs/benchmarks.md` describes a method but its results are `TBD`, and the README has no numbers.

Publishing performance numbers is easy to do badly: numbers from an unstated machine, a warm cache passed off as a proxy, a "baseline" that is not comparable, or figures copied into the README by hand that no longer match any run. This spec makes the benchmarks **reproducible with one command, traceable to committed raw results, and honest when a target is missed**.

There is also a tooling gap: the `mock` provider runs **inside** the gateway process, so there is no upstream HTTP hop and nothing to call "directly" for a baseline. Measuring overhead fairly needs a mock upstream reachable over HTTP, called both through the gateway and directly.

## User stories
- As a **prospective user**, I want published latency and resilience numbers with the hardware and versions they were measured on, so I can judge whether Switchyard fits my latency budget.
- As a **maintainer**, I want one command that runs every scenario and stores raw results, so I can rerun after a change and compare.
- As a **reviewer**, I want every number in the README to trace back to a committed raw result, so I can trust none were typed by hand.
- As a **maintainer**, I want a missed target reported as missed, with an issue to fix it, rather than a methodology quietly tuned until it passes.

## Concepts
- **Mock upstream:** a standalone OpenAI-compatible HTTP server under `bench/` that reuses the `mock` provider's behaviour and knobs (`latencyMs`, `chunkDelayMs`, `errorRate`, and the `error-<status>` / `error-midstream` model names). The gateway reaches it through the `openai-compatible` adapter, exactly like a real provider.
- **Direct baseline:** the same k6 request shape and arrival rate sent straight to the mock upstream, on the same machine and in the same run, bypassing the gateway.
- **Client-side overhead:** the difference between the latency percentiles measured through the gateway and the direct baseline (a difference of percentiles, not the percentile of differences; ADR-0021).
- **Server-side overhead:** `switchyard_gateway_overhead_seconds` (spec 011) over the same window, read from Prometheus after the run.
- **Run:** one execution of the benchmark command, identified by a run id, producing a folder under `bench/results/`.

## Acceptance criteria (EARS)

### Harness
- **AC-1** THE repository SHALL provide the mock upstream of the Concepts section, configurable by environment or flags for latency, chunk delay and error rate, with unit tests showing each knob's effect (latency honoured, errors injected at the configured rate within a statistical tolerance, chunks spaced by the configured delay).
- **AC-2** WHEN a developer runs `pnpm bench` on a machine with Docker, THE command SHALL, without other manual steps: start the stack with the gateway built from the production `Dockerfile` (telemetry enabled, ADR-0011), start the mock upstream(s), create the benchmark teams and keys through the admin API, run every scenario of AC-3 with k6 from a pinned `grafana/k6` Docker image, collect the server-side metrics, write the run folder of AC-5, and stop what it started. It SHALL work on Windows (Docker Desktop) and Linux, and `pnpm bench -- --scenario <name>` SHALL run a single scenario.

### Scenarios
- **AC-3** THE harness SHALL implement these k6 scenarios, each with a warm-up phase excluded from results and a steady phase whose arrival rate and duration are fixed in ADR-0021 and recorded in the run:
  - `no-cache`: non-streaming chat through auth, rate limit and budget, with `cache.exact` and `cache.semantic` **disabled** and key limits high enough never to trip; paired with the direct baseline;
  - `exact-cache`: identical deterministic requests with the exact cache enabled; the run SHALL record the observed hit ratio from response headers or metrics, and results SHALL be labelled as cache hits;
  - `streaming`: SSE streams with a configured chunk delay; reports time to first byte through the gateway vs direct, and total stream time;
  - `rate-limited`: load above a low-`rpm` key's limit; SHALL verify that the number of admitted requests per window does not exceed the limit (plus the bucket's initial capacity) and that every rejection is a well-formed `429` with `retry-after`;
  - `chaos`: an alias whose primary candidate is a mock upstream failing 30% of requests and whose secondary is healthy; reports the client-visible success rate.
- **AC-4** EVERY scenario SHALL fail its run (non-zero exit, marked in the report) on **correctness** errors, independent of speed: unexpected status codes (anything other than `200`, and `429` in `rate-limited`), malformed bodies or SSE streams, or responses missing the `x-switchyard-*` headers.

### Results and publication
- **AC-5** EACH run SHALL write `bench/results/<run-id>/` containing the raw k6 summary per scenario, the server-side metrics of the run window, `environment.json` (CPU model and cores, RAM, OS and version, Docker version and the CPU/memory available to Docker, Node version, k6 version and image digest, gateway image digest, git commit and whether the tree was dirty, a hash of the benchmark config) and a generated `summary.md`. Runs from a dirty tree SHALL be marked as such and SHALL NOT be publishable.
- **AC-6** THE results table in `docs/benchmarks.md` and the README benchmark table SHALL be **generated** by `pnpm bench:report` from the run folders selected for publication, each row naming its run id; no number SHALL appear in either table that is not in a committed raw result. WHEN `pnpm verify` runs, A check SHALL fail if either committed table differs from what `pnpm bench:report` would generate.
- **AC-7** THE report SHALL show, per scenario, p50/p95/p99 latency and achieved request rate through the gateway, the same for the direct baseline where one exists, the client-side overhead percentiles, the server-side overhead percentiles and the error/success counts. Both overhead measures SHALL be published side by side; neither SHALL be omitted because it looks worse.

### Targets and honesty
- **AC-8** THE report SHALL evaluate two targets and state each as **met** or **missed** next to the measured value: (T1) p95 gateway overhead below 15 ms in `no-cache` (evaluated on the client-side overhead, ADR-0021), and (T2) at least 99% success in `chaos`. These are targets to verify, not claims; the README SHALL NOT state either as achieved unless the published run meets it.
- **AC-9** IF a published run misses a target, THEN the miss SHALL be published as measured, a GitHub issue SHALL be opened (labelled `performance`) with the run id and the evidence, and the report SHALL link it. Changing the methodology (scenario shape, arrival rate, durations, what is subtracted) SHALL require amending ADR-0021 first and rerunning **all** scenarios; selecting a subset of runs or discarding a run because of its result is not allowed (every run considered for publication stays in `bench/results/`).

### CI and docs
- **AC-10** CI SHALL run a short variant of every scenario (`pnpm bench -- --smoke`) on each pull request that touches `bench/`, `src/` or the `Dockerfile`, failing only on correctness (AC-4) and harness errors, never on latency; its numbers SHALL NOT be published or committed.
- **AC-11** `docs/benchmarks.md` SHALL document the methodology from ADR-0021 (where the load generator runs and why, warm-up, durations, arrival model, baseline, both overhead measures, known limitations of Docker Desktop such as no CPU pinning and shared VM), how to run and how to read the results; the README SHALL show the generated table with a link to the methodology and the hardware it was measured on.

## Non-goals
- Benchmarks against real providers or models (their latency and prices are not ours to publish), and comparisons with other gateways.
- Measuring the semantic cache's cost savings and quality loss on a replay dataset (plan goal 4); a separate spec if pursued.
- Tuning the gateway's performance; this spec measures, and issues opened by AC-9 drive any tuning.
- Benchmarking on cloud hardware or the deployed demo (spec 013), and continuous performance tracking across commits.
- Multi-instance or horizontal-scaling benchmarks.

## Open questions
- Where does the published run come from: the reference machine (Windows 10, Docker Desktop/WSL2, 4 cores, 16 GB) or a GitHub-hosted runner? (Proposed: the reference machine, because that is the documented target environment; CI runs only the smoke variant, since shared runners are too noisy to publish. The README states the machine.)
- Should k6 run in a container next to the gateway or on another machine? (Proposed: in a container on the same host, as the only free option; k6, the gateway and the mock compete for the same CPUs, which ADR-0021 documents as a limitation and the direct baseline partly cancels out.)
- Is the primary overhead measure the client-side difference of percentiles or the server-side histogram? (Proposed: client-side for target T1, because it includes everything a user experiences such as HTTP parsing and connection handling; server-side published alongside as a cross-check.)
- Does the mock upstream live under `bench/` or reuse `src/modules/providers/mock.ts` from a new entry point? (Proposed: a small server under `bench/mock-upstream/` that imports the existing mock logic, so behaviour stays identical and nothing benchmark-only ships in the gateway image.)
- Should `rate-limited` measure the cost of rejections (latency of a `429`)? (Proposed: yes, report rejection latency percentiles as an extra row; no target.)
