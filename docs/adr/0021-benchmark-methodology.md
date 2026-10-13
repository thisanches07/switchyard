# 0021. Benchmark methodology: containerised k6 on the reference machine, paired with a direct baseline

- **Status:** Accepted
- **Date:** 2026-10-13
- **Related specs:** 012-benchmarks, 011-observability

## Context
Spec 012 publishes gateway overhead and resilience numbers and checks them against two targets (p95 overhead < 15 ms without cache; ≥ 99% success with a primary failing 30% of the time). The numbers must be reproducible by anyone with Docker, measured for free, and comparable across runs. Constraints:
- The only hardware available is the reference machine (Windows 10, 4 cores, 16 GB, Docker Desktop on WSL2) and free GitHub-hosted runners. There is no second machine for the load generator.
- Docker Desktop runs every container inside one WSL2 VM; `cpuset`/`cpus` limits apply inside the VM, but the VM's vCPUs are scheduled by Windows alongside everything else, so there is **no real CPU pinning or isolation**.
- The `mock` provider runs in-process, so an HTTP mock upstream is needed both for a realistic hop and for a direct baseline.
- A difference of percentiles (p95 through gateway − p95 direct) is not the p95 of per-request overhead; the two can disagree, especially in the tail.

## Options considered
1. **k6 in a pinned Docker image on the same host, open-model arrival rate, warm-up then fixed steady phase, paired gateway vs direct-to-mock runs in the same session, server-side overhead histogram as a cross-check**: free, cross-platform, one command; the load generator steals CPU from the system under test, partly cancelled out by running the baseline under the same conditions.
2. **k6 on a separate machine or cloud VM**: removes CPU contention and is closer to production; needs a second machine or a cloud account the owner does not have, and adds network variance.
3. **Publish numbers from GitHub-hosted runners**: anyone can reproduce in CI; shared runners have noisy neighbours and unknown hardware generations, so tail latency is unstable between runs.
4. **Closed-model load (fixed virtual users, as fast as possible)**: simpler and shows max throughput, but suffers from coordinated omission (a slow gateway lowers its own load), which hides tail latency.

## Decision
We will use **option 1** on the reference machine for published numbers:
- **Load generator:** k6 from a version-pinned `grafana/k6` image (digest recorded), on the Compose network, with Docker's CPU and memory allowance recorded in `environment.json`. Docker Desktop's lack of CPU isolation is stated next to every published table.
- **Arrival model:** k6 `constant-arrival-rate` (open model) at a fixed rate chosen **below saturation** of the direct baseline on the reference machine; the rate, warm-up length and steady-phase length are set once in the benchmark config, recorded per run, and changed only by amending this ADR.
- **Warm-up:** each scenario starts with a warm-up phase (JIT, connection pools, auth cache, Redis scripts loaded) whose samples are excluded via k6 tags.
- **Baseline:** for `no-cache` and `streaming`, the same request shape and rate is sent directly to the mock upstream in the same run, before the gateway pass; mock latency is identical in both.
- **Overhead:** the primary measure for the target is the **client-side difference of percentiles** (gateway minus direct, for p50/p95/p99); the **server-side** `switchyard_gateway_overhead_seconds` percentiles are published alongside. If they disagree materially, the report says so rather than picking the friendlier one.
- **Runs:** published numbers come from a clean tree; a run is repeated at least three times and the report shows every run's values (the median run is highlighted, none are dropped).
- **CI:** runs a short smoke variant for correctness only (option 3 is rejected for publication).

## Consequences
- ✅ Free, reproducible with one command on Windows and Linux, and honest about its limits.
- ✅ The open model avoids coordinated omission; the paired baseline isolates gateway cost from mock latency and host noise.
- ⚠️ Same-host load generation and no CPU pinning add noise and may overstate overhead; the numbers describe this machine, not production.
- ⚠️ Difference-of-percentiles is an approximation of per-request overhead; mitigated by publishing the server-side histogram too.
- 🔁 Revisit when a second machine or a free cloud VM (spec 013) is available to host the load generator, or if run-to-run variance makes targets impossible to judge.
