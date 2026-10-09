# Spec 001: Project bootstrap

- **Status:** Draft (review, then change to Approved)
- **Owner:** @thisanches07
- **Related ADRs:** 0001, 0002 (Node + TS + Fastify), 0011 (OpenTelemetry)

## Problem
We need a runnable, tested, observable skeleton so every following feature starts from the same quality baseline, on both Windows (primary dev machine) and Linux (CI).

## User stories
- As a **contributor**, I want one command to start the local stack, so I can develop without manual setup.
- As a **maintainer**, I want CI to block broken code, so `main` is always releasable.
- As an **operator**, I want health/readiness endpoints and telemetry from day one.

## Development environment (prerequisites)
| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS | Pinned in `.nvmrc` and `package.json#engines`. On Windows install via `fnm` or `nvm-windows`. |
| pnpm | via Corepack | `corepack enable`; version pinned in `package.json#packageManager`. |
| Docker Desktop | ≥ 4.x, Compose v2 | WSL2 backend. Use **named volumes**, not bind mounts, for databases (bind mounts are slow on Windows). |
| Ollama | latest | Runs **natively** on the host to use the GPU; containers reach it at `http://host.docker.internal:11434`. Optional compose profile `ollama` for CPU-only/Linux setups. |

Reference machine: Windows 10, 4 cores, 16 GB RAM, GTX 1060 6 GB. The default stack must fit comfortably on it.

## Acceptance criteria (EARS)
- **AC-1** WHEN a developer runs `docker compose up -d`, THE stack SHALL start the gateway, Postgres 17 (with pgvector), Redis, Redpanda and grafana/otel-lgtm.
- **AC-2** WHERE the `ollama` compose profile is enabled, THE stack SHALL also start an Ollama container; otherwise THE gateway SHALL use the host Ollama URL from config.
- **AC-3** THE Redpanda container SHALL run with bounded resources (`--smp 1 --memory 1G --overprovisioned`), and the default stack (AC-1) SHALL stay under ~4 GB RAM at idle.
- **AC-4** WHEN `GET /healthz` is called, THE gateway SHALL respond `200 {"status":"ok"}`.
- **AC-5** WHEN `GET /readyz` is called AND Postgres and Redis are reachable, THE gateway SHALL respond 200; IF any dependency is unreachable, THEN it SHALL respond 503 listing the failing dependency.
- **AC-6** WHEN the gateway starts with an invalid `config/switchyard.yaml` or missing required env vars, THE process SHALL exit with a non-zero code and a human-readable validation error.
- **AC-7** WHEN any HTTP request is handled, THE gateway SHALL emit an OpenTelemetry span and a JSON log line containing the same trace id.
- **AC-8** WHEN a pull request is opened, THE CI SHALL run lint, typecheck, unit tests and build on Linux, and fail on any error.
- **AC-9** WHEN the process receives SIGTERM, THE gateway SHALL stop accepting connections and exit within 10 s.
- **AC-10** THE repository SHALL include `.gitattributes` (`* text=auto eol=lf`), `.editorconfig`, `.nvmrc`, `.gitignore`, `.env.example`, `LICENSE` (MIT) and `config/switchyard.example.yaml`.

## Non-goals
- Any `/v1/*` proxy behaviour (spec 002).
- Authentication (spec 004).
- Kafka producer/consumer code (spec 006); Redpanda only needs to be running.

## Resolved questions
- *Should Ollama be in a separate compose profile?* **Yes.** Native Ollama is the default on the reference machine (GPU access); the `ollama` profile exists for CPU-only/Linux.
