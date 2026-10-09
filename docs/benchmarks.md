# Benchmarks

> Filled in by spec 012. Numbers are only published after they are measured; nothing here is estimated.

## Method
- Tool: k6, scripts in `bench/`.
- Upstream: `mock` provider with fixed latency, so results measure **gateway overhead**, not model speed.
- Overhead = gateway total latency − mock upstream latency (also exported as `switchyard_gateway_overhead_seconds`).
- Each scenario: warm-up, then a steady load; report p50/p95/p99 and RPS.

## Hardware
_To be recorded with each run (CPU, RAM, OS, Docker resources, Node version)._

## Scenarios

| Scenario | Description |
|---|---|
| `no-cache` | Proxy only, auth + rate limit + budget enabled |
| `exact-cache` | Same requests repeated, exact cache hits |
| `streaming` | SSE streams, measure TTFB overhead |
| `rate-limited` | Load above the key limit, verify 429 correctness and cost |
| `chaos` | Mock fails 30% of requests, measure success via fallback |

## Results
_TBD_
