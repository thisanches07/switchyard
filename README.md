<div align="center">

# 🚦 Switchyard

**A self-hosted, OpenAI-compatible LLM gateway: routing, fallbacks, budgets, caching and PII redaction, with full observability.**

Point your existing OpenAI SDK at Switchyard. Get control over cost, reliability and data, without changing your app.

[![CI](https://github.com/thisanches07/switchyard/actions/workflows/ci.yml/badge.svg)](https://github.com/thisanches07/switchyard/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-24_LTS-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-enabled-425CC7?logo=opentelemetry&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Quickstart](#-quickstart) · [Features](#-features) · [Architecture](#-architecture) · [Benchmarks](#-benchmarks) · [Docs](#-documentation) · [Roadmap](#-roadmap)

</div>

---

## Why

Teams that ship LLM features quickly run into the same problems:

- 💸 **Costs nobody can explain.** Which team, key or feature spent what?
- 🔥 **Provider outages and 429s** take the product down with them.
- 🔐 **Sensitive data** (emails, card numbers, national IDs) leaks into third-party prompts.
- 🧩 **Every provider has a different API**, so switching models means rewriting code.

Switchyard sits between your apps and model providers and handles all of this in one place.

## ✨ Features

| | |
|---|---|
| 🔌 **Drop-in OpenAI API** | `/v1/chat/completions` (incl. SSE streaming), `/v1/embeddings`, `/v1/models`. Works with the official SDKs. |
| 🧭 **Smart routing** | Model aliases (`fast`, `smart`, `cheap`), priority / lowest-cost / lowest-latency strategies. |
| 🛟 **Resilience** | Retries with jittered backoff, automatic fallback, per-provider circuit breakers. |
| 🔑 **Virtual keys & teams** | Scoped keys with allowed models, hashed at rest, revocable. |
| 🚥 **Rate limiting** | Requests/min and tokens/min per key and team (atomic Redis Lua). |
| 💰 **Budgets** | Monthly USD budgets with soft alerts and hard limits. |
| ⚡ **Caching** | Exact cache (Redis) and semantic cache (pgvector), tenant-scoped. |
| 🛡️ **PII redaction** | Detects emails, phones, cards (Luhn), CPF/CNPJ; mask reversibly, or block. |
| 📊 **Observability** | OpenTelemetry traces, metrics and logs with ready-made Grafana dashboards. |
| 📨 **Usage pipeline** | Usage events through Kafka (Redpanda) to an idempotent worker with a DLQ. |

**Providers:** OpenAI · Anthropic · Google Gemini · Groq · OpenRouter · Ollama (local) · Mock

## 🚀 Quickstart

> 🚧 **Status: early development.** The v0.1 milestone is in progress. Today the stack boots with validated config, health/readiness endpoints, traces and CI ([spec 001](docs/specs/001-bootstrap/spec.md)); the `/v1/*` and admin API shown below arrive with specs 002–008 ([backlog](docs/specs/README.md)).

```bash
git clone https://github.com/thisanches07/switchyard && cd switchyard
cp .env.example .env
docker compose up -d --wait # gateway, Postgres, Redis, Redpanda, Grafana (LGTM)
ollama pull llama3.2 && ollama pull nomic-embed-text   # local models (or: docker compose --profile ollama up -d)
```

Create a key:

```bash
curl -s localhost:8080/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"team":"demo","name":"my-app","allowedModels":["fast","local"]}'
# → { "key": "sk-sy-…" }   (shown only once)
```

Use it with the **official OpenAI SDK**. Only the `baseURL` changes:

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:8080/v1", apiKey: process.env.SWITCHYARD_KEY });

const stream = await client.chat.completions.create({
  model: "fast",                       // an alias: routed + fallback handled by Switchyard
  messages: [{ role: "user", content: "Explain circuit breakers in one paragraph." }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="sk-sy-...")
print(client.chat.completions.create(model="local", messages=[{"role": "user", "content": "Hi!"}]).choices[0].message.content)
```

Open Grafana at **http://localhost:3000** to watch cost, latency and cache hits live.

## 🏗 Architecture

```mermaid
flowchart LR
  C[Client apps<br/>OpenAI SDK] -->|HTTPS| G

  subgraph G[Switchyard Gateway]
    A[Auth] --> RL[Rate limit] --> B[Budget] --> P[PII] --> CA[Cache] --> R[Router]
  end

  R --> O[OpenAI-compatible<br/>OpenAI · Groq · Ollama · Gemini]
  R --> AN[Anthropic]

  G <--> RD[(Redis)]
  G <--> PG[(Postgres + pgvector)]
  G -->|usage events| K[[Kafka / Redpanda]] --> W[Usage worker] --> PG
  G -. OTLP .-> GR[Grafana · Prometheus · Tempo · Loki]
```

Every request flows through a pipeline of small, testable stages. See [`docs/architecture.md`](docs/architecture.md) and the [ADRs](docs/adr) for the reasoning behind each decision.

## ⚙️ Configuration

Routes and providers live in a single validated YAML file (hot-reloaded):

```yaml
providers:
  ollama:  { type: openai-compatible, baseUrl: http://host.docker.internal:11434/v1 }
  groq:    { type: openai-compatible, baseUrl: https://api.groq.com/openai/v1, apiKeyEnv: GROQ_API_KEY }
  claude:  { type: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }

aliases:                # model IDs below are examples; check each provider's docs
  fast:
    strategy: priority
    candidates: [groq/llama-3.1-8b-instant, ollama/llama3.2]
  smart:
    strategy: lowest-latency
    candidates: [claude/claude-sonnet-5-5, groq/llama-3.3-70b-versatile]
```

## 📈 Benchmarks

> Measured with [k6](bench/) against a mock provider to isolate gateway overhead. Hardware and method: [`docs/benchmarks.md`](docs/benchmarks.md).

| Scenario | RPS | Overhead p50 | Overhead p95 | Overhead p99 |
|---|---|---|---|---|
| Proxy, no cache | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Exact cache hit | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Streaming (TTFB) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

| Resilience test | Result |
|---|---|
| Primary provider failing 30% of requests | _TBD_ % success via fallback |
| Semantic cache on replay dataset | _TBD_ % cost saved |

## 🧪 Quality

- Unit tests (Vitest) and integration tests on real Postgres/Redis (Testcontainers)
- Compose smoke test: health, readiness, invalid config, memory budget, graceful SIGTERM
- Strict TypeScript, Biome, Dependabot, CI on every PR
- Planned: contract tests with the official OpenAI SDKs (spec 002–003), chaos tests (spec 008), k6 benchmarks (spec 012), CodeQL

## 🛠 Development

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS | `.nvmrc`; on Windows use [fnm](https://github.com/Schniz/fnm) |
| pnpm | via Corepack | `corepack enable` |
| Docker | Desktop or Engine with Compose v2 | the default stack uses about 1 GB of RAM at idle |
| Ollama | optional | runs on the host to use the GPU; or `docker compose --profile ollama up -d` |

```bash
pnpm install
pnpm verify          # lint + typecheck + unit tests + build
pnpm test:int        # integration tests on real Postgres/Redis (Testcontainers, needs Docker)
pnpm test:smoke      # boots the Compose stack and checks health, readiness, bad config, memory, SIGTERM
pnpm dev             # gateway in watch mode (copy .env.example to .env and config/switchyard.example.yaml to config/switchyard.yaml)
```

Traces: run the stack, send a few requests to `http://localhost:8080/readyz`, then open Grafana at http://localhost:3000 → Explore → Tempo and search for service `switchyard-gateway`.

## 📚 Documentation

- [Architecture](docs/architecture.md)
- [Architecture Decision Records](docs/adr)
- [Feature specs](docs/specs) (each feature is spec'd with EARS acceptance criteria before it's built)
- [Threat model](docs/threat-model.md)
- [Benchmarks](docs/benchmarks.md)

> 🤖 This project is built with a **spec-driven workflow with Claude Code**: specs → design → tasks → test-first implementation. See [`CLAUDE.md`](CLAUDE.md).

## 🗺 Roadmap

- [x] Project bootstrap: validated config, health/readiness, traces + correlated logs, graceful shutdown, Compose stack, CI
- [ ] OpenAI-compatible proxy + streaming
- [ ] Virtual keys, teams, rate limiting
- [ ] Usage pipeline (Kafka) + budgets
- [ ] Routing, fallback, circuit breakers
- [ ] Exact + semantic cache
- [ ] PII redaction (reversible masking)
- [ ] Grafana dashboards + published benchmarks
- [ ] Terraform deploy (Oracle Cloud Always Free)
- [ ] Anthropic-compatible `/v1/messages`

## 🤝 Contributing

Issues and PRs are welcome. Start with an issue, and for larger changes a spec in `docs/specs/`.

## 📄 License

[MIT](LICENSE)
