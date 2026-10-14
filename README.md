<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img alt="Switchyard: the self-hosted, OpenAI-compatible LLM gateway" src="docs/assets/banner-light.svg" width="100%">
</picture>

<p>
  <b>One endpoint in front of every model.</b> Point the official OpenAI SDK at Switchyard and get routing,<br>
  resilience, cost control and end-to-end observability, without changing your application code.
</p>

[![CI](https://img.shields.io/github/actions/workflow/status/thisanches07/switchyard/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/thisanches07/switchyard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-3B5BDB)](LICENSE)
![Node.js 24](https://img.shields.io/badge/Node.js-24_LTS-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-traces%20·%20metrics%20·%20logs-425CC7?logo=opentelemetry&logoColor=white)
[![Spec-driven](https://img.shields.io/badge/built-spec--driven-0CA678)](docs/specs/README.md)

[**Quickstart**](#-quickstart) ·
[**How it works**](#-how-it-works) ·
[**Configuration**](#%EF%B8%8F-configuration) ·
[**Observability**](#-observability) ·
[**Development**](#-development) ·
[**Roadmap**](#%EF%B8%8F-roadmap) ·
[**Docs**](#-documentation)

<br>

<img src="docs/assets/demo.svg" alt="Terminal demo: docker compose up, then a chat request through Switchyard answered by a local llama3.2 model" width="92%">

<sub>Real request, recorded on a laptop GPU (GTX 1060) running <code>llama3.2</code> through Ollama.</sub>

</div>

<br>

> [!NOTE]
> **Status: v0.1 in progress.** Chat completions (including **SSE streaming**), embeddings, model listing, provider adapters, error mapping, tracing and metrics are **working and tested today**, plus **virtual API keys with teams**, an admin API, **per-minute rate limits** shared across instances and a **usage event pipeline** (Kafka → idempotent worker → Postgres), **cost per request and monthly budgets**, contract-tested with the official OpenAI Node and Python SDKs. Fallback and caching are specified and on the [roadmap](#%EF%B8%8F-roadmap).

> [!WARNING]
> Docker Compose ships `dev-only` defaults for `ADMIN_TOKEN` and `KEY_PEPPER` so it works out of the box, and publishes every port on `127.0.0.1` only. Set real secrets in `.env` before exposing the gateway; it logs a warning while dev-only values are in use.

## ✨ Why Switchyard

Teams shipping LLM features hit the same walls:

| Problem | What Switchyard does |
|---|---|
| 🧩 Every provider has a different API | One **OpenAI-compatible** API in front of Ollama, Groq, Gemini, OpenRouter, OpenAI and more |
| 🔁 Model names leak into application code | **Aliases** (`fast`, `smart`, `local`) resolved by the gateway, so swapping models is a config change |
| 🔥 Provider outages and 429s take the product down | Retries, **fallback** and circuit breakers *(spec 008)* |
| 💸 Nobody can explain the bill | Usage events, **per-team budgets** and cost metrics *(specs 006–007)* |
| 🔐 Personal data leaks into third-party prompts | **PII redaction** for emails, cards, CPF/CNPJ *(spec 010)* |
| 🕳️ "Why was this request slow?" | **OpenTelemetry** spans for every hop, correlated with logs by `trace_id` |

## 🧭 Features

| | Feature | Status |
|---|---|:---:|
| 🔌 | OpenAI-compatible `POST /v1/chat/completions` (official SDKs work unchanged) | ✅ |
| 🌊 | **Streaming (SSE)** with no buffering, time-to-first-token metric, upstream cancelled when the client disconnects | ✅ |
| 🧬 | `POST /v1/embeddings` (float and base64), routed through the same aliases | ✅ |
| 📋 | `GET /v1/models` listing aliases and configured models | ✅ |
| 🧭 | Aliases and `provider/model` routing (model ids may contain `/`) | ✅ |
| 🧱 | Provider adapters: any OpenAI-compatible endpoint + deterministic **mock** for tests | ✅ |
| 🧯 | Consistent OpenAI-shaped errors (400 / 404 / 413 / 415 / 429 / 502 / 504) with upstream internals never leaked | ✅ |
| ⏱️ | Connect, time-to-first-byte and total timeouts on every upstream call | ✅ |
| 🔭 | Upstream spans following the OpenTelemetry **GenAI conventions**, request duration and **gateway overhead** metrics, `x-switchyard-*` headers | ✅ |
| 📊 | **Grafana dashboards and alert rules as code** (Overview, Cost, Providers), loaded on `docker compose up`, checked in CI against the metrics the code emits; `pnpm demo:traffic` | ✅ |
| ❤️ | `/healthz`, `/readyz` with time-bounded dependency checks, graceful shutdown | ✅ |
| 🔑 | **Virtual API keys** (`sk-sy-…`, stored only as peppered hashes), teams, per-key model allow-lists, revocation | ✅ |
| 🚥 | **Rate limits** in requests and tokens per minute, per key and per team, atomic in Redis (Lua), OpenAI-style `429` + `x-ratelimit-*` | ✅ |
| 🛠️ | Admin API for teams and keys; OpenAPI document and interactive UI at `/docs` | ✅ |
| 📨 | **Usage events** through Kafka (Redpanda): never blocks a request, idempotent worker, daily aggregates, DLQ, `GET /admin/usage` | ✅ |
| 🤖 | **Anthropic (Claude)** adapter: `claude/...` models behind `/v1/chat/completions`, streaming and tools included | ✅ |
| 🪞 | Anthropic-compatible `POST /v1/messages` for the official Anthropic SDKs, routed to Claude natively or to any other provider | ✅ |
| 💰 | **Cost per request** from a versioned price table (unknown prices stay unknown, never `$0`) and **monthly budgets** per key and team: soft-limit warning, hard `429`, enforced across instances in Redis, reconciled with Postgres | ✅ |
| 🛟 | **Fallback, retries with full jitter and circuit breakers** before the first byte; `priority`, `lowest-cost` and `lowest-latency` aliases; config **hot reload** | ✅ |
| ⚡ | **Response cache**: exact (Redis) for deterministic requests and an opt-in, team-scoped **semantic** cache (pgvector); hits cost $0, savings are measured, streams are replayed as SSE | ✅ |
| 🛡️ | **PII redaction** per key: `mask` (placeholders such as `<CPF_1>`, restored in the answer) or `block`; e-mail, phone, card, CPF, CNPJ, IP and a deny-list | ✅ |

## 🚀 Quickstart

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) with Compose v2. Optional: [Ollama](https://ollama.com) for a real local model.

**1. Start the stack** (gateway, Postgres, Redis, Redpanda and Grafana LGTM; about 1 GB of RAM at idle)

```bash
git clone https://github.com/thisanches07/switchyard.git
cd switchyard
docker compose up -d --wait
```

**2. Create an API key** through the admin API (the snippet uses [`jq`](https://jqlang.org); the interactive UI at <http://localhost:8080/docs> works too). Compose ships a `dev-only` admin token for local use; set `ADMIN_TOKEN` and `KEY_PEPPER` in `.env` before exposing anything.

```bash
ADMIN="Authorization: Bearer dev-only-admin-token-change-me"
TEAM=$(curl -s localhost:8080/admin/teams -H "$ADMIN" -H "content-type: application/json" \
  -d '{"name":"my-team"}' | jq -r .id)
export SWITCHYARD_KEY=$(curl -s localhost:8080/admin/keys -H "$ADMIN" -H "content-type: application/json" \
  -d "{\"teamId\":\"$TEAM\",\"name\":\"my-app\"}" | jq -r .key)
echo $SWITCHYARD_KEY   # sk-sy-… shown only once; only its hash is stored
```

**3. Send a request** to the built-in mock provider (no model needed):

```bash
curl -s localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $SWITCHYARD_KEY" -H "content-type: application/json" \
  -d '{"model":"mock/demo","messages":[{"role":"user","content":"Hello!"}]}'
```

**4. Use a real model.** With Ollama running on your machine, the `local` alias routes to `ollama/llama3.2`:

```bash
ollama pull llama3.2
curl -s localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $SWITCHYARD_KEY" -H "content-type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"What is a circuit breaker? One sentence."}]}'
```

<details>
<summary><b>Windows PowerShell</b> (5.1 strips quotes from <code>curl.exe</code> arguments; use this instead)</summary>

```powershell
$admin = @{ Authorization = "Bearer dev-only-admin-token-change-me" }
$team = Invoke-RestMethod http://localhost:8080/admin/teams -Method Post -Headers $admin `
  -ContentType "application/json" -Body '{"name":"my-team"}'
$created = Invoke-RestMethod http://localhost:8080/admin/keys -Method Post -Headers $admin `
  -ContentType "application/json" -Body (@{ teamId = $team.id; name = "my-app" } | ConvertTo-Json)
$env:SWITCHYARD_KEY = $created.key

$body = @{ model = "local"; messages = @(@{ role = "user"; content = "What is a circuit breaker? One sentence." }) } | ConvertTo-Json -Depth 5
$r = Invoke-RestMethod http://localhost:8080/v1/chat/completions -Method Post `
  -Headers @{ Authorization = "Bearer $env:SWITCHYARD_KEY" } `
  -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
$r.choices[0].message.content
```
</details>

### Use it from your code

Only the `baseURL` changes, and your Switchyard key goes where the OpenAI key used to.

<table>
<tr><th>TypeScript / Node.js</th><th>Python</th></tr>
<tr>
<td>

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: process.env.SWITCHYARD_KEY, // sk-sy-…
});

const res = await client.chat.completions.create({
  model: "local", // alias resolved by Switchyard
  messages: [{ role: "user", content: "Hi!" }],
});
console.log(res.choices[0].message.content);
```

</td>
<td>

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key=os.environ["SWITCHYARD_KEY"],  # sk-sy-…
)

res = client.chat.completions.create(
    model="local",  # alias resolved by Switchyard
    messages=[{"role": "user", "content": "Hi!"}],
)
print(res.choices[0].message.content)
```

</td>
</tr>
</table>

**Streaming and embeddings** work the same way:

```ts
const stream = await client.chat.completions.create({
  model: "local",
  messages: [{ role: "user", content: "Write a haiku about trains." }],
  stream: true, // tokens arrive as they are generated
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");

const { data } = await client.embeddings.create({ model: "embed", input: ["hello", "world"] });
console.log(data[0].embedding.length); // 768 with nomic-embed-text
```

```bash
# -N disables curl's buffering so you can watch the SSE events arrive
curl -N localhost:8080/v1/chat/completions -H "content-type: application/json" \
  -d '{"model":"local","stream":true,"messages":[{"role":"user","content":"Count to 5"}]}'
```

Any OpenAI-compatible client works the same way (LangChain, LlamaIndex, Vercel AI SDK, …).

### Run the published images

Each release tag publishes two multi-arch images to GHCR, for **`linux/amd64`** and **`linux/arm64`** (x86 servers, Apple Silicon, Raspberry Pi 4/5, Ampere VMs), tagged `X.Y.Z`, `X.Y` and `latest`:

| Image | Default command |
|---|---|
| `ghcr.io/thisanches07/switchyard-gateway:<version>` | the gateway (port 8080, health check on `/healthz`) |
| `ghcr.io/thisanches07/switchyard-worker:<version>` | the usage worker (spec 006) |

```bash
docker pull ghcr.io/thisanches07/switchyard-gateway:0.1.0
docker pull ghcr.io/thisanches07/switchyard-worker:0.1.0
```

The production Compose profile in [`deploy/compose/`](deploy/compose/) runs them by version behind [Caddy](https://caddyserver.com) (automatic HTTPS), with only ports 80 and 443 published and every secret taken from an env file:

```bash
cp deploy/compose/switchyard.env.example switchyard.env   # replace every replace-me value
docker compose -f deploy/compose/compose.yml --env-file switchyard.env up -d --wait
```

To run it on a free Oracle Cloud ARM VM with Terraform, follow the **[deploy runbook](docs/deploy.md)**. Release notes are in [CHANGELOG.md](CHANGELOG.md).

## 🏗 How it works

### Architecture

```mermaid
flowchart LR
  subgraph Clients
    SDK["OpenAI SDK<br/>Node · Python · curl"]
  end

  subgraph GW["Switchyard (Fastify)"]
    direction LR
    AUTH["API key auth<br/>teams · allow-lists"] --> V["Validate<br/>(Zod)"]
    V --> RES["Resolve model<br/>alias → provider/model"]
    RES --> LIM --> PII --> AD["Provider adapter<br/>timeouts · error mapping"]
    LIM["Rate limits<br/>Redis token buckets"]
    PII["PII mask / block"]
    BUD["Budgets<br/>Redis spend counters"]
    CACHE["Exact + semantic cache<br/>Redis · pgvector"]
    FB["Fallback · circuit breaker"]:::planned
  end

  SDK -->|"POST /v1/chat/completions"| AUTH
  AD -->|undici| OL["Ollama"]
  AD -->|undici| OAI["Groq · Gemini · OpenRouter · OpenAI"]
  AD --> MOCK["Mock provider"]
  AD --> EV["Usage event<br/>(in-memory buffer)"]

  subgraph Infra["Docker Compose stack"]
    direction LR
    LGTM["Grafana LGTM<br/>traces · metrics · logs"]
    PG[("Postgres<br/>+ pgvector")]
    RD[("Redis")]
    KF[["Redpanda<br/>usage.events.v1"]]
    WK["Usage worker<br/>idempotent · DLQ"]
  end

  EV -->|async| KF --> WK --> PG
  GW -. "OTLP · health" .-> Infra

  classDef planned stroke-dasharray: 5 5,opacity:0.6
```

<sub>Dashed boxes are specified but not built yet. See the [roadmap](#%EF%B8%8F-roadmap).</sub>

### Life of a request (today)

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (OpenAI SDK)
  participant G as Switchyard
  participant P as Provider (e.g. Ollama)

  C->>G: POST /v1/chat/completions (Bearer sk-sy-…)
  G->>G: hash key → team · key · allowed models (cached 30 s)
  alt missing / revoked key · model not allowed
    G-->>C: 401 invalid_api_key · 403 model_not_allowed
  end
  G->>G: validate body · resolve "local" → ollama/llama3.2
  G->>G: rate limits: take 1 request + estimated tokens (Redis, atomic)
  alt over a limit
    G-->>C: 429 + retry-after + x-ratelimit-*
  end
  alt unknown model
    G-->>C: 404 model_not_found (no provider called)
  end
  loop each attempt (candidate in strategy order, skipping open breakers)
    G->>P: POST {baseUrl}/chat/completions (model rewritten)
    Note over G,P: upstream span per attempt (chat model)<br/>connect · TTFB timeouts · whole-request budget
    alt 5xx · 408 · 429 · network error · timeout
      P-->>G: retryable failure → next candidate (backoff when it repeats)
    end
  end
  alt 2xx
    P-->>G: chat.completion + usage
    G-->>C: 200 body + x-switchyard-provider / -model / -attempts
  else non-retryable 4xx
    P-->>G: provider error
    G-->>C: same status at once, OpenAI error shape
  else every attempt failed
    G-->>C: last error: 502 upstream_error / 504 upstream_timeout / 429
  end
  G->>G: record one usage event (buffered, published to Kafka in the background)
```

### Model resolution

```mermaid
flowchart TD
  M["model in the request"] --> A{"Is it an alias?<br/>(local, fast, smart…)"}
  A -- yes --> F["Every candidate the key may use,<br/>ordered by the alias strategy"]
  A -- no --> S{"provider/model with a<br/>configured provider?"}
  S -- yes --> D["That provider, model kept as-is<br/>openrouter/meta-llama/llama-3.3-70b"]
  S -- no --> N["404 model_not_found"]
  F --> CALL["Attempt loop: retries, fallback,<br/>circuit breakers (spec 008)"]
  D --> CALL
```

### Error contract

Every error, from validation to provider failures, comes back in the OpenAI shape, so SDKs raise their usual typed exceptions (`NotFoundError`, `RateLimitError`, …). The one exception is `/v1/messages`, which answers in the [Anthropic shape](#-anthropic-claude) with the same statuses and the `code` below in `error.details.error_code`.

| Situation | Status | `code` |
|---|:---:|---|
| Invalid JSON or body | 400 | `invalid_json` / `invalid_request` |
| Missing, unknown, revoked or expired API key | 401 | `invalid_api_key` |
| Model outside the key's allow-list | 403 | `model_not_allowed` |
| Over a request or token limit (key, team or failed-auth address) | 429 | `rate_limit_exceeded` (`type`: `requests` or `tokens`) |
| A single request needs more tokens than the per-minute limit | 400 | `request_too_large_for_limit` |
| Personal data in the request of a key in PII `block` mode | 400 | `pii_detected` (types only, never values) |
| Redis down with `limits.onRedisError: closed` | 503 | `rate_limiter_unavailable` |
| Unknown model | 404 | `model_not_found` |
| Body too large / not JSON | 413 / 415 | `request_too_large` / `unsupported_media_type` |
| Provider 4xx (e.g. 429) | same | passed through |
| Provider 5xx, connection refused, invalid response | 502 | `upstream_error` (provider body never forwarded) |
| Provider timeout, or `server.timeouts.totalMs` spent across attempts | 504 | `upstream_timeout` |
| Every candidate's circuit breaker is open | 503 + `retry-after` | `no_healthy_upstream` |
| Provider configured without its API key | 503 | `provider_not_configured` |
| Anthropic rate limit / overloaded (`529`) / rejected operator key | 429 / 503 / 502 | `upstream_rate_limited` / `upstream_overloaded` / `upstream_auth_error` |
| Parameter the provider cannot honour (e.g. `n > 1` on Claude) | 400 | `unsupported_parameter` |
| Embeddings on a provider without them (Anthropic) | 400 | `embeddings_not_supported` |

## ⚙️ Configuration

Providers and aliases live in one YAML file, validated at boot with readable errors (a typo such as `grok/llama` fails fast and lists the known providers). Start from [`config/switchyard.example.yaml`](config/switchyard.example.yaml):

```yaml
providers:
  ollama:
    type: openai-compatible
    baseUrlEnv: OLLAMA_BASE_URL      # http://host.docker.internal:11434/v1 from Docker
  groq:
    type: openai-compatible
    baseUrl: https://api.groq.com/openai/v1
    apiKeyEnv: GROQ_API_KEY          # read from the environment, never from the file
  mock:
    type: mock                       # deterministic, for tests and benchmarks

aliases:                             # model ids are examples; check each provider's docs
  local: { strategy: priority, candidates: [ollama/llama3.2] }
  fast:  { strategy: priority, candidates: [groq/llama-3.1-8b-instant, ollama/llama3.2] }
```

<details>
<summary><b>Environment variables</b></summary>

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP listener |
| `SWITCHYARD_CONFIG` | `config/switchyard.yaml` | Path to the YAML config |
| `DATABASE_URL` | required | Postgres (`postgres://…`) |
| `KEY_PEPPER` | required, ≥ 32 chars | Secret mixed into API key hashes. **Back it up**: losing it invalidates every key |
| `ADMIN_TOKEN` | unset | Enables the admin API (≥ 16 chars) |
| `MIGRATE_ON_BOOT` | `false` | Apply database migrations at startup (Compose sets `true`; otherwise run `pnpm db:migrate`) |
| `REDIS_URL` | required (gateway and worker) | Redis (`redis://…`): rate limits and budget counters; the worker reconciles budgets |
| `KAFKA_BROKERS` | required when `usage.enabled` (gateway) and for the worker | Comma-separated `host:port` list, e.g. `localhost:19092` |
| `LOG_LEVEL` | `info` | pino log level |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP collector, e.g. `http://localhost:4318` |
| `SHUTDOWN_TIMEOUT_MS` | `9000` | Hard deadline for graceful shutdown |
| `OLLAMA_BASE_URL`, `GROQ_API_KEY`, `GEMINI_API_KEY`, … | unset | Referenced by `baseUrlEnv` / `apiKeyEnv` in the config |

See [`.env.example`](.env.example).
</details>

<details>
<summary><b>Ports published by Docker Compose</b> (all on 127.0.0.1)</summary>

| Service | Port | |
|---|---|---|
| Gateway | `8080` | the API |
| Grafana | `3000` | dashboards and Explore (login `admin` / `admin`) |
| OTLP | `4317` / `4318` | telemetry in (gRPC / HTTP) |
| Postgres | `55432` | `POSTGRES_HOST_PORT` to change; 55432 avoids clashing with a local install |
| Redis | `6379` | `REDIS_HOST_PORT` to change |
| Redpanda | `19092` | Kafka API |
</details>

## 🔑 API keys and the admin API

Every `/v1` request needs a Switchyard key (`Authorization: Bearer sk-sy-…`), the same way the OpenAI API does. Keys belong to **teams**, can be restricted to certain models, and can be revoked at any time. Only a peppered SHA-256 hash of each key is stored, and keys never appear in logs.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/admin/teams` | Create a team `{ name, rpm?, tpm?, monthlyBudgetUsd?, softLimitPct? }` |
| `GET` | `/admin/teams` | List teams |
| `POST` | `/admin/keys` | Create a key `{ teamId, name, allowedModels?, expiresAt?, rpm?, tpm?, piiMode?, monthlyBudgetUsd? }`; the plaintext key is returned **only here** |
| `GET` | `/admin/keys?teamId=` | List keys (prefix, status, limits; never the key or its hash) |
| `PATCH` | `/admin/keys/:id` | Set or clear (`null`) the key's `rpm` / `tpm`, `piiMode` and `monthlyBudgetUsd` |
| `PATCH` | `/admin/teams/:id` | Set or clear the team's `rpm` / `tpm` caps, `monthlyBudgetUsd` and `softLimitPct` |
| `POST` | `/admin/keys/:id/revoke` | Revoke a key; rejected immediately on this instance, everywhere within 30 s |
| `GET` | `/admin/usage?from=&to=&groupBy=&teamId=&keyId=` | Requests, tokens and cost per team, key, model, provider or day ([usage](#-usage-events)) |
| `GET` | `/admin/keys/:id/budget`, `/admin/teams/:id/budget` | Limit, spend this month, remaining, soft/hard flags ([budgets](#-costs-and-budgets)) |
| `GET` | `/admin/providers/health` | Breaker state, EWMA latency and error rate of every candidate, on this instance ([routing](#-routing-and-resilience)) |
| `POST` | `/admin/config/reload` | Validate and apply the config file now; `400 invalid_config` keeps the old one |

`allowedModels` accepts aliases (`fast`), exact refs (`ollama/llama3.2`) and provider wildcards (`ollama/*`); `/v1/models` then lists only what the key may use. Admin routes take `Authorization: Bearer <ADMIN_TOKEN>` and do not exist at all when `ADMIN_TOKEN` is unset.

📖 The full API, including request bodies, is documented in OpenAPI at **<http://localhost:8080/docs>**.

## 🛟 Routing and resilience

An alias lists several candidates; Switchyard tries them so that one provider hiccup does not reach your users ([spec 008](docs/specs/008-routing-resilience/spec.md)).

```yaml
aliases:
  fast:  { strategy: priority,       candidates: [groq/llama-3.1-8b-instant, gemini/gemini-2.5-flash, ollama/llama3.2] }
  smart: { strategy: lowest-latency, candidates: [claude/claude-sonnet-5-5, gemini/gemini-2.5-pro] }
retry:          { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000 }
circuitBreaker: { failureThreshold: 10, openMs: 10000 }
routing:        { ewmaAlpha: 0.3, hotReload: true }
```

- **Strategies:** `priority` (config order), `lowest-cost` (estimated request cost from the pricing file; unknown prices last), `lowest-latency` (unmeasured candidates first, then by EWMA latency). Candidates the key may not use are skipped (`403` only when none is left).
- **Retries and fallback:** a connection error, a timeout before the first byte, or an upstream `408`/`429`/`5xx` moves on to the next candidate, wrapping around, up to `retry.maxAttempts` attempts **in total**. Retrying a candidate already tried waits a full-jitter backoff (at least its `Retry-After`, capped at `maxDelayMs`). Any other `4xx` is returned at once.
- **Never after the first byte:** a stream that fails after its first chunk ends with an error event and is not retried ([ADR-0008](docs/adr/0008-no-retry-after-first-byte.md)); it still counts against the candidate's breaker.
- **Timeouts:** `connectMs` and `ttfbMs` per attempt; `totalMs` bounds the whole request across attempts and backoff waits (up to the first chunk for streams).
- **Circuit breakers** per `provider/model`: open after `failureThreshold` consecutive failures, skipped for `openMs`, then one probe. When every candidate is open the answer is `503 no_healthy_upstream` with `retry-after`. State lives in memory on each instance; `GET /admin/providers/health` shows it.
- **Headers:** `x-switchyard-provider` / `x-switchyard-model` name the candidate that served (or the last one tried), `x-switchyard-attempts` the attempts made; the usage event has the same `attempts`.
- **Hot reload** ([ADR-0018](docs/adr/0018-config-hot-reload.md)): edit the config file and new requests use it within ~2.5 s (polling), or call `POST /admin/config/reload`, or send `SIGHUP` (Linux). In-flight requests finish with their config; an invalid file is rejected and logged, and the old config keeps serving. Breaker and latency state survive for candidates whose provider definition is unchanged. `server.bodyLimitBytes`, `server.trustProxy`, `server.timeouts.connectMs`, `limits.authFailuresPerMinutePerIp`, `usage` and `pricingFile` need a restart (a reload logs them). Environment variables are not reloaded.

```bash
curl -si localhost:8080/v1/chat/completions -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"resilient","messages":[{"role":"user","content":"hi"}]}' | grep x-switchyard
# x-switchyard-model: smoke         (mock/error-503 failed first)
# x-switchyard-attempts: 2
```

## 🚥 Rate limits

Every authenticated request takes **1 request** and an **estimate of its tokens** from token buckets in Redis, in one atomic Lua call shared by all gateway instances:

| Bucket | Limit |
|---|---|
| Key | its own `rpm` / `tpm`, else `limits.defaults` from the config (60 RPM / 100 000 TPM in the example) |
| Team | its own `rpm` / `tpm` caps across all its keys (optional) |
| Client address | `limits.authFailuresPerMinutePerIp` failed authentications (30), checked **before** the database |

The token estimate is `ceil(input characters / 4)` plus `max_completion_tokens`, `max_tokens` or `limits.completionReserveTokens` (512). When the response arrives, the reservation is **reconciled** with the real usage: unused tokens go back, overruns are charged, and failed calls are refunded. Streams are reconciled when they end, fail or the client disconnects.

```http
HTTP/1.1 429 Too Many Requests
retry-after: 27
x-ratelimit-limit-requests: 2
x-ratelimit-remaining-requests: 0
x-ratelimit-reset-requests: 1m0s

{"error":{"type":"requests","code":"rate_limit_exceeded","message":"Rate limit reached for requests (key limit: 2 per minute)…"}}
```

The headers describe the **most restrictive** bucket and use the OpenAI format, so the official SDKs back off on their own. If Redis is unreachable the gateway keeps serving by default (`limits.onRedisError: open`, counted in `switchyard_ratelimit_fail_open_total`), or answers `503` with `closed`.

## 📊 Usage events

Every request that passes authentication and rate limiting produces **exactly one usage event**, however it ends: success, provider error, a stream that fails half-way, or a client that hangs up. Events carry **metadata only** (ids, model, provider, tokens, latency, status, outcome), never prompt or response content ([ADR-0010](docs/adr/0010-no-prompt-persistence.md)).

```mermaid
flowchart LR
  R["Request ends"] --> B["In-memory buffer<br/>(bounded, never blocks)"]
  B -->|"every 200 ms<br/>key = team id"| K[["usage.events.v1"]]
  K --> W["Usage worker"]
  W -->|"one transaction:<br/>insert … on conflict do nothing<br/>+ daily aggregate"| PG[("usage_events<br/>usage_daily")]
  W -->|malformed| DLQ[["usage.events.dlq"]]
```

- **Never in the way:** the request only appends to a buffer. If Kafka is down the gateway keeps serving; the buffer (`usage.bufferSize`, 10 000) holds events until the broker is back, then new events are **dropped and counted** in `switchyard_usage_events_dropped_total{reason="buffer_full"}` (ADR-0007). On `SIGTERM` the buffer is flushed before exit.
- **Counted once:** events have UUIDv7 ids; the worker inserts with `ON CONFLICT (id) DO NOTHING` and updates `usage_daily` only for rows it actually inserted, in the same transaction, and commits Kafka offsets only after that. Redeliveries and worker restarts never double-count.
- **Bad messages set aside:** invalid JSON or schema violations go to `usage.events.dlq` with the original bytes and headers naming the reason and the source partition/offset. Re-publish them after fixing the cause, for example with `rpk topic consume usage.events.dlq` piped into `rpk topic produce usage.events.v1`.

```bash
curl -s "localhost:8080/admin/usage?groupBy=model&from=2026-10-01" -H "$ADMIN" | jq
```

```json
{
  "from": "2026-10-01", "to": "2026-10-13", "groupBy": "model",
  "data": [
    { "group": "ollama/llama3.2", "requests": 42, "inputTokens": 5120, "outputTokens": 9310,
      "costUsd": "0", "unknownCostRequests": 0 }
  ],
  "totals": { "requests": 42, "inputTokens": 5120, "outputTokens": 9310, "costUsd": "0", "unknownCostRequests": 0 }
}
```

`groupBy` is `team`, `key`, `model`, `provider` or `day` (default; `from`/`to` default to the last 30 days, at most 366). `costUsd` sums known costs only; requests whose price is unknown are counted in `unknownCostRequests` ([costs](#-costs-and-budgets)). Results are eventually consistent: a request shows up within seconds. Set `usage.enabled: false` to run without Kafka.

## 💰 Costs and budgets

Every request gets a cost in USD from [`config/pricing.yaml`](config/pricing.yaml) (USD per 1M tokens per `provider/model`, `*` patterns allowed). Prices nobody has verified stay `TODO`: those requests have an **unknown** cost (`null`), never `$0`, and the gateway lists such models in a warning at boot. Non-streaming responses carry the cost:

```http
x-switchyard-cost-usd: 0.0000140000
```

Give a key or a team a **monthly budget** (calendar month, UTC):

```bash
curl -s -X PATCH localhost:8080/admin/teams/$TEAM -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"monthlyBudgetUsd": 200, "softLimitPct": 90}'
```

- At `softLimitPct` % (default 80) requests carry `x-switchyard-budget-warning: soft_limit_reached`.
- At 100 % they get `429` with `type: insufficient_quota`, `code: budget_exceeded` and `x-should-retry: false`, before any provider is called (the OpenAI SDKs raise `RateLimitError` and don't retry).
- Responses report the tightest budget in `x-switchyard-budget-limit-usd`, `x-switchyard-budget-remaining-usd` and `x-switchyard-budget-reset`; `GET /admin/keys/:id/budget` shows the details.
- Spend lives in Redis counters shared by every instance, and the usage worker raises them to the Postgres totals every minute, so a Redis restart is repaired within one interval. With Redis down, budgeted requests get `503 budget_unavailable` (`budgets.onRedisError: closed`, the default) or are admitted (`open`).

There is no cost reservation: requests already in flight when a budget runs out still finish, so a month can overshoot by at most their cost. Details: [budgets guide](docs/budgets.md).

## ⚡ Response caching

Repeated requests can be answered without calling a provider (spec 009). Only `/v1/chat/completions` uses the cache; `/v1/embeddings` and `/v1/messages` never do.

| Layer | Store | When a request uses it |
|---|---|---|
| **Exact** | Redis, `cache.exact.ttlSeconds` | `cache.exact.enabled`, `temperature: 0` present (or `x-switchyard-cache: force`), `n` absent or 1 |
| **Semantic** | Postgres + pgvector, `cache.semantic.ttlSeconds` | `cache.semantic.enabled` **and** the key's `semanticCacheEnabled`; `temperature` present and ≤ `maxTemperature` (0.3); no tools; the last message is user text. Served when a stored final user message is similar enough (cosine ≥ `similarityThreshold`, 0.95) and the earlier turns and parameters are identical |

```bash
# Opt a key in to the semantic cache
curl -s -X PATCH localhost:8080/admin/keys/$KEY_ID -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"semanticCacheEnabled": true}'
```

- Responses carry `x-switchyard-cache: hit | semantic-hit | miss | bypass`. Send `x-switchyard-cache: bypass` to skip the cache (no read, no write) or `force` to use the exact cache at any temperature; any other value gets `400 invalid_cache_header`.
- A hit has a new `id` and `created`, the provider/model that originally answered in `x-switchyard-provider`/`x-switchyard-model`, and `x-switchyard-attempts: 0`. Asked for as a stream, it arrives as normal SSE chunks ending in `data: [DONE]` (with a usage chunk only if `stream_options.include_usage`).
- **Accounting:** a hit passes the same rate-limit and budget admission (one request unit; TPM reconciled to the stored usage), costs `0` and adds nothing to budgets. `switchyard_cache_savings_usd_total` adds what it would have cost at current prices; hits with an unknown price are counted in `switchyard_cache_savings_unknown_total` instead.
- **Isolation:** entries are scoped by team, candidate model and every output-affecting parameter ([ADR-0019](docs/adr/0019-exact-cache-key-normalisation.md), [ADR-0009](docs/adr/0009-semantic-cache-scoping.md)); one team never receives another team's answer.
- **What is stored:** the provider's response to the request as sent upstream. With PII `mask` the cache holds placeholders, never the original values, and each request restores its own. Exact entries live in Redis memory (persistence is off in the Compose stack) until their TTL; semantic entries are rows of `semantic_cache_entries`, deleted hourly once expired. Cache keys, embeddings and content are never logged or traced.
- **Failures:** if Redis, Postgres or the embedding model fails, times out (`lookupTimeoutMs`, 300 ms) or returns a vector that is not 768-dimensional, that layer is skipped and the request is served as a `miss`.
- The semantic layer embeds the final user message with `cache.semantic.embeddingModel` (default `ollama/nomic-embed-text`, 768 dims) through the configured provider: one call, not charged to the key.

## 🛡️ PII redaction

Personal data in prompts can be **masked** before it reaches the provider, or the request **blocked**. Set a default in the config and override it per key (`piiMode` on `POST /admin/keys` and `PATCH /admin/keys/:id`; `null` falls back to the default):

```yaml
pii:
  defaultMode: off            # off | mask | block
  detectors: [email, phone, card, cpf, cnpj, ip, term]
  denyList: ["Project Falcon"] # literal terms, case-insensitive, whole words
```

With `mask`, each value becomes a typed placeholder (`<CPF_1>`, `<EMAIL_1>`, the same value always gets the same one) and the original comes back in the answer, so the application does not notice:

```text
client → gateway   "My CPF is 529.982.247-25"
gateway → provider "My CPF is <CPF_1>"
provider → gateway "Got it, <CPF_1> is registered."
gateway → client   "Got it, 529.982.247-25 is registered."     x-switchyard-pii: masked
```

With `block`, the request gets `400 pii_detected` naming only the types found (`cpf, email`); no provider is called and the reserved tokens are refunded.

| `x-switchyard-pii` | Meaning |
|---|---|
| `masked` | Values were replaced and restored in the answer (chat, embeddings and **streamed** answers) |
| `masked-unrestored` | Only for **Claude-native `/v1/messages` streams**, which are forwarded byte for byte and keep the placeholders |
| `none` | The key scans but nothing was found |
| `blocked` | On the `400 pii_detected` response of a `block` key |
| (absent) | Mode `off`: nothing is scanned |

In **streams** a placeholder can arrive split (`<CP` + `F_1>`), so the gateway holds back only text that could still become a known placeholder and sends everything else at once. A held fragment is released as soon as the next character rules it out, or **unrestored** after `pii.streamRestore.maxHoldMs` (250 ms by default) if the stream stalls ([spec 015](docs/specs/015-pii-streaming-restore/spec.md)).

Detectors use check digits (CPF, CNPJ including the 2026 alphanumeric format), Luhn (cards) and real address parsers (IP), so a random 11-digit number is not a CPF. **Names, addresses and other free text are not detected**, and restoring is best-effort: a model that rewrites `<CPF_1>` as `CPF 1` gets it back unrestored. Original values and the placeholder map live only in the memory of the request: never in logs, spans, metrics, Redis or Postgres. Details: [PII redaction guide](docs/pii.md).

## 🤖 Anthropic (Claude)

Switchyard speaks Anthropic in **both directions** ([spec 014](docs/specs/014-anthropic/spec.md), [ADR-0016](docs/adr/0016-anthropic-messages-compatibility.md)):

```mermaid
flowchart LR
  O["OpenAI SDK<br/>/v1/chat/completions"] --> C["canonical request<br/>(keys · limits · telemetry)"]
  A["Anthropic SDK<br/>/v1/messages"] --> C
  C -->|claude/...| AN["Anthropic API<br/>POST /v1/messages"]
  C -->|any other provider| OT["Ollama · Groq · Gemini · mock …"]
```

**Outbound: Claude behind the OpenAI API.** Add an `anthropic` provider and use `claude/<model>` or an alias:

```yaml
providers:
  claude:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
    defaultMaxTokens: 4096   # Anthropic requires max_tokens; used when the request sets none
```

System messages, tools and tool calls, images, `stop`, streaming (with usage) and errors are translated. Usage folds prompt-cache reads and writes into `prompt_tokens` and reports reads in `prompt_tokens_details.cached_tokens`. If answers stop early with `finish_reason: "length"`, raise `defaultMaxTokens` or send `max_tokens`.

**Inbound: the Anthropic SDKs against Switchyard.** Point the SDK at the gateway origin and use your Switchyard key (`x-api-key` and `Authorization: Bearer` are both accepted, on every `/v1` route):

```python
import os
import anthropic

client = anthropic.Anthropic(base_url="http://localhost:8080", api_key=os.environ["SWITCHYARD_KEY"])
message = client.messages.create(model="smart", max_tokens=1024,
                                 messages=[{"role": "user", "content": "Hi!"}])
```

`model` resolves exactly like chat (alias or `provider/model`, allow-lists, `x-switchyard-*` headers), every request passes the rate limits with `max_tokens` as its allowance, and responses carry `anthropic-ratelimit-*` headers next to `x-ratelimit-*`. Errors use the Anthropic shape (`{"type":"error","error":{"type","message","details":{"error_code"}},"request_id"}`), so the SDK raises `RateLimitError`, `NotFoundError`, … as usual.

- **Claude models (same family):** the request is sent upstream as the client wrote it (thinking blocks, `cache_control`, documents, citations, server tools, `top_k`, `anthropic-beta`), and the response or SSE stream comes back unchanged except `model`.
- **Other providers (cross family):** the request is translated; the response is a regular Anthropic `message` (or SSE events) with an `msg_…` id.

**Limitations**

| | |
|---|---|
| Thinking through `/v1/chat/completions` | Thinking blocks are **dropped** from OpenAI responses and cannot be sent back. Models with mandatory thinking may reject multi-turn tool loops through the OpenAI API; use `/v1/messages` for those (opt-in live check: `SWITCHYARD_LIVE_ANTHROPIC=1 ANTHROPIC_API_KEY=… pnpm test:contract`). |
| OpenAI parameters Claude cannot honour | `n > 1`, `logprobs`, `top_logprobs` and `response_format` other than `text` → `400 unsupported_parameter`; `presence_penalty`, `frequency_penalty`, `seed`, `logit_bias` and unknown fields are dropped (listed in the span attribute `switchyard.dropped_params`). |
| `/v1/messages` on non-Anthropic models | `document` blocks, server tools and images inside `tool_result` → `400`; earlier thinking blocks and `cache_control` are dropped; prompt-cache usage is reported as `0`. |
| Not provided | `count_tokens`, Message Batches, Files, Models and beta endpoints; Bedrock / Vertex / Foundry. |
| Embeddings on `anthropic` providers | `400 embeddings_not_supported` |

Upstream `429`, `5xx`, `529` and timeouts are classified as retryable (and `401` from Anthropic as the operator's problem, `502 upstream_auth_error`), ready for fallback in spec 008. `/v1/messages` produces one usage event per admitted request (`operation: "messages"`, with Anthropic `cache_read_input_tokens` as `cachedInputTokens`) and goes through PII redaction like chat: masked text reaches Claude inside the client's own blocks, thinking blocks and documents are forwarded unscanned, and answers are restored (streams too, except Claude-native streams, which keep placeholders and say `masked-unrestored`).

## 🔭 Observability

Every response tells you what happened:

```http
HTTP/1.1 200 OK
x-switchyard-request-id: req_5b9e1fd5-2c46-4adf-b99a-dbf336c523aa
x-switchyard-provider: ollama
x-switchyard-model: llama3.2
x-switchyard-attempts: 1
x-switchyard-upstream-ms: 986
```

| Signal | Name | Details |
|---|---|---|
| Span | `{operation} {model}` (e.g. `chat llama3.2`), kind `CLIENT` | one per upstream attempt, [GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai): `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens` / `output_tokens`, `error.type`; plus `switchyard.stage: upstream`, `switchyard.provider.name`, `switchyard.candidate`, `switchyard.attempt`, `switchyard.attempt.outcome`, `switchyard.backoff_ms` |
| Histogram | `switchyard_request_duration_seconds` | whole request, arrival to last byte, by `operation`, `stream`, `status` class, `cache` |
| Histogram | `switchyard_gateway_overhead_seconds` | time the gateway adds: duration − upstream time − backoff (to the first byte for streams), same labels |
| Counter | `switchyard_tokens_total` | by `direction` (`input`, `output`), `provider`, `model`; matches the usage events |
| Counter | `switchyard_requests_total` | by `provider`, `model`, `status`, `team`; one per client request (the attempt that served or failed last) |
| Counter | `switchyard_upstream_attempts_total` | every attempt, by `candidate` and `outcome` (`success`, `retryable_error`, `non_retryable_error`, `timeout`, `midstream_error`) |
| Gauge | `switchyard_circuit_state` | per `candidate`: `0` closed, `1` half-open, `2` open; transitions are logged |
| Counter | `switchyard_config_reloads_total` | config reloads by `result` (`success`, `failure`) |
| Histogram | `switchyard_upstream_duration_seconds` | by `provider`, `model`, `outcome` |
| Histogram | `switchyard_ttfb_seconds` | time to first streamed token, by `provider`, `model` |
| Counter | `switchyard_ratelimit_rejections_total` | by `scope` (`key`, `team`, `ip`) and `kind` (`requests`, `tokens`) |
| Counter | `switchyard_auth_failures_total` | rejected `/v1` requests by `reason` (`missing`, `malformed`, `unknown`, `revoked`, `expired`) |
| Counters | `switchyard_usage_events_published_total`, `switchyard_usage_events_dropped_total` | usage events acknowledged by Kafka; dropped by `reason` (`buffer_full`, `shutdown`, `invalid`) |
| Gauge | `switchyard_usage_buffer_events` | usage events waiting in the gateway's buffer |
| Counter | `switchyard_usage_worker_events_total` | worker results: `inserted`, `duplicate`, `dlq` |
| Span | `switchyard.usage.consume` | one per worker batch, with message and result counts |
| Counters | `switchyard_cost_usd_total`, `switchyard_cost_unknown_requests_total` | known cost in USD and unknown-cost requests, by `provider`, `model` |
| Counters | `switchyard_budget_rejections_total`, `switchyard_budget_soft_limit_requests_total` | by `scope` (`key`, `team`); plus `switchyard_budget_fail_open_total`, `switchyard_budget_charge_failures_total` |
| Gauge | `switchyard_budget_used_ratio` | spend ÷ monthly budget, by `scope`, `id` |
| Span | `switchyard.budget` | budget check: `switchyard.budget.scope`, `switchyard.budget.decision` |
| Counter | `switchyard_pii_detections_total` | PII occurrences found, by `type`; request spans carry `switchyard.pii.mode` / `.action` / `.detections` |
| Histogram, counter | `switchyard_pii_stream_hold_seconds`, `switchyard_pii_stream_restore_failures_total` | time streamed text was held while it could be a placeholder; fragments released unrestored, by `reason` (`hold_limit`) |
| Logs | JSON (pino) | every line carries `trace_id` / `span_id`, plus `teamId` / `keyId` once authenticated; secrets redacted |

> [!IMPORTANT]
> Prompt and response **content is never written to logs or spans** ([ADR-0010](docs/adr/0010-no-prompt-persistence.md)). Only metadata such as tokens, latency and status is recorded.

**Dashboards and alerts:** `docker compose up -d`, then `pnpm demo:traffic` (mock provider only) and open Grafana at <http://localhost:3000> → **Dashboards → Switchyard**: **Overview** (traffic, errors, duration, overhead, TTFB, tokens, rejections, dropped events), **Cost** (spend by model, requests by team, unknown costs, budgets), **Providers** (per-provider errors and latency, retries, circuit state) and **Cache** (hit ratio, lookups, USD saved, errors). Four example alert rules (error rate, breaker open, budget near limit, usage events dropped) load with them; add your own contact point in Grafana. Everything lives in [`deploy/grafana/`](deploy/grafana) and `pnpm verify` fails if a panel queries a metric the code does not emit. Definitions, panels, rules and the rule for new metrics: [docs/observability.md](docs/observability.md).

<!-- Screenshots (spec 011, AC-11): captured by the owner following docs/observability.md § Screenshots.
![Grafana Overview dashboard](docs/assets/dashboard-overview.png)
*Grafana, Overview dashboard, fed by `pnpm demo:traffic` (mock provider). Captured at commit `<hash>`.*
![Grafana Providers dashboard](docs/assets/dashboard-providers.png)
*Grafana, Providers dashboard, fed by `pnpm demo:traffic` (mock provider). Captured at commit `<hash>`.*
-->

**See a trace:** open Grafana at <http://localhost:3000> → **Explore** → **Tempo** → search service `switchyard-gateway`; upstream calls carry `switchyard.stage = upstream`.

## 📈 Benchmarks

Two targets to verify, not claims: **T1** p95 gateway overhead below 15 ms without cache, and **T2** at least 99 % success when the primary provider fails 30 % of the time. `pnpm bench` runs every k6 scenario (no cache, exact cache, streaming, rate limited, chaos) against the Docker stack and a mock upstream, paired with a direct baseline; the table below is generated by `pnpm bench:report` from the committed raw results, and `pnpm verify` fails if anyone edits it by hand. Method, limitations and every run: [docs/benchmarks.md](docs/benchmarks.md).

<!-- bench:readme:start -->
<!-- Generated by `pnpm bench:report` from bench/results/. Do not edit by hand. -->

**No published benchmark run yet.** `pnpm bench` is in place; numbers appear here only after a clean run on the reference machine is committed. The targets below are goals to verify, not results. Method: [docs/benchmarks.md](docs/benchmarks.md).

| Target | Measured | Status |
| --- | --- | --- |
| T1: p95 gateway overhead below 15 ms (`no-cache`, client-side) | not measured | not evaluated |
| T2: at least 99 % success with a primary failing 30 % of the time (`chaos`) | not measured | not evaluated |
<!-- bench:readme:end -->

## 🛠 Development

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS | pinned in `.nvmrc`; on Windows use [fnm](https://github.com/Schniz/fnm) |
| pnpm | via Corepack | `corepack enable` |
| Docker | Compose v2 | Desktop or Engine |
| Ollama | optional | runs on the host to use the GPU, or `docker compose --profile ollama up -d` |

```bash
pnpm install
cp .env.example .env && cp config/switchyard.example.yaml config/switchyard.yaml
pnpm dev             # gateway in watch mode
pnpm dev:worker      # usage worker in watch mode (needs KAFKA_BROKERS, e.g. localhost:19092)
```

### Quality gates

| Command | What it checks |
|---|---|
| `pnpm verify` | Biome lint · strict typecheck · unit tests with **≥ 80% line coverage** on core and modules · build |
| `pnpm test:int` | Real Postgres, Redis and Redpanda (Testcontainers), real HTTP timeouts and connection failures, the usage pipeline end to end |
| `pnpm test:contract` | The **official OpenAI and Anthropic Node SDKs** against the gateway: chat, streaming, embeddings, tools, `/v1/messages` (mock and an in-process fake Anthropic server always; Ollama when running) |
| `pnpm db:migrate` | Applies database migrations to `DATABASE_URL` (`pnpm db:generate` creates new ones from the Drizzle schema) |
| `pnpm test:contract:py` | The same with the **official OpenAI and Anthropic Python SDKs** (needs `pip install -r test/contract/python/requirements.txt`; on Windows, enable long paths or use a short venv path) |
| `pnpm test:smoke` | Boots the Compose stack: health, readiness, a chat request, rate limits, a request counted in `GET /admin/usage`, a cost header then `budget_exceeded`, Grafana dashboards and alert rules provisioned with Overview series, bad config, memory budget, graceful SIGTERM |
| `pnpm check:grafana` | Validates `deploy/grafana` dashboards and alert rules against the metrics `src/` emits (also part of `pnpm verify`) |
| `pnpm demo:traffic` | Sends a configurable mix of mock-only traffic to the running stack so the dashboards have data |
| `pnpm bench` | k6 benchmarks against the Compose stack and a mock upstream; writes a run folder under `bench/results/` ([method](docs/benchmarks.md)). `pnpm bench -- --smoke` is the correctness-only variant CI runs |
| `pnpm bench:report` | Regenerates the benchmark tables of the README and `docs/benchmarks.md` from the committed runs (`pnpm verify` checks they match) |

```mermaid
flowchart LR
  PR["Pull request"] --> V["verify<br/>lint · types · unit + coverage · build"]
  PR --> I["integration<br/>Testcontainers"]
  PR --> S["compose smoke<br/>full stack in Docker"]
  PR -. "bench/, src/, Dockerfile" .-> B["bench smoke<br/>k6 scenarios, correctness only"]
  V --> C["contract<br/>OpenAI SDK"]
```

<details>
<summary><b>Project structure</b></summary>

```
src/
├─ server.ts            entry point: config → clients → app → listen → graceful shutdown
├─ worker.ts            usage worker entry point (usage-worker.ts wires Kafka and Postgres)
├─ app.ts               buildApp(deps): injectable, so tests use fakes
├─ config/              Zod schemas for env and YAML, readable errors
├─ core/                canonical types, ports and errors (no infra imports)
├─ modules/
│  ├─ health/           /healthz, /readyz
│  ├─ proxy/            /v1/chat/completions, /v1/messages, /v1/models, upstream telemetry
│  ├─ anthropic/        pure Anthropic ↔ canonical translation (requests, responses, SSE, errors)
│  ├─ providers/        openai-compatible, anthropic, mock, registry
│  ├─ routing/          alias and model resolution
│  └─ usage/            request-outcome hook, usage publisher, worker batches, usage reports
└─ infra/               undici HTTP client, Postgres, Redis, Kafka, logger, OpenTelemetry
bench/                  k6 benchmarks: mock upstream, scenarios, run orchestrator, report generator
test/                   unit · integration · contract
docs/                   architecture, ADRs, specs, threat model
```
</details>

## 🧠 How this project is built

Switchyard is developed **spec-first with Claude Code**. Nothing is implemented without an approved spec, every non-trivial decision is an [ADR](docs/adr/README.md), and every acceptance criterion maps to a test.

```mermaid
flowchart LR
  B["Backlog<br/>docs/specs/README.md"] --> S["/spec<br/>EARS acceptance criteria"]
  S --> H{"Human<br/>approval"}
  H --> D["/design<br/>contracts · diagrams · ADRs"]
  D --> T["/tasks<br/>small, test-linked tasks"]
  T --> I["/implement<br/>test first → code → pnpm verify"]
  I -->|next task| I
  I --> VF["/verify<br/>AC → test table"]
```

Each spec ends with a verification table, for example [spec 002](docs/specs/002-chat-proxy/tasks.md#verification-2026-10-10). The rules the assistant follows are in [`CLAUDE.md`](CLAUDE.md).

## 🗺️ Roadmap

**v0.1: a working gateway**
- [x] [001](docs/specs/001-bootstrap/spec.md) Bootstrap: validated config, health/readiness, traces + correlated logs, graceful shutdown, Compose, CI
- [x] [002](docs/specs/002-chat-proxy/spec.md) Chat proxy: `/v1/chat/completions`, `/v1/models`, adapters, error mapping, upstream telemetry, SDK contract tests
- [x] [003](docs/specs/003-streaming/spec.md) Streaming (SSE) and `/v1/embeddings`, Node + Python SDK contract tests
- [x] [004](docs/specs/004-keys-and-teams/spec.md) Virtual API keys, teams, admin API, Postgres migrations, OpenAPI docs
- [x] [005](docs/specs/005-rate-limiting/spec.md) Rate limiting: RPM / TPM per key and team, Redis Lua token buckets, token reservation and reconciliation
- [x] [006](docs/specs/006-usage-pipeline/spec.md) Usage events pipeline: one event per request, Kafka (Redpanda), idempotent worker, daily aggregates, DLQ, `GET /admin/usage`
- [x] [007](docs/specs/007-budgets/spec.md) Budgets and cost accounting: price table, cost per request, monthly budgets per key and team, Redis counters reconciled with Postgres
- [x] [008](docs/specs/008-routing-resilience/spec.md) Routing strategies, retries, fallback, circuit breakers, timeouts and config hot reload
- [x] [014](docs/specs/014-anthropic/spec.md) Anthropic adapter and `/v1/messages`: Claude behind the OpenAI API, the Anthropic SDKs in front of any provider

**v0.2: savings and safety:** exact and semantic cache, PII redaction
- [x] [009](docs/specs/009-caching/spec.md) Exact and semantic response caching: Redis and pgvector, team-scoped, SSE replay of hits, savings metrics

**v0.3: proof and production**
- [x] [013](docs/specs/013-deploy/spec.md) Deploy: multi-arch images on GHCR, tag-driven releases, production Compose behind Caddy, `pnpm demo:key`, Terraform + cloud-init for Oracle Cloud Always Free ([runbook](docs/deploy.md))
- Grafana dashboards as code, published k6 benchmarks

Full scope and dependencies: [spec backlog](docs/specs/README.md).

## 📚 Documentation

| | |
|---|---|
| 🏛️ [Architecture](docs/architecture.md) | Components, request pipeline, data model, failure behaviour |
| 🧾 [Architecture Decision Records](docs/adr/README.md) | Why Fastify, why Kafka, why no retries after the first streamed byte, … |
| 📐 [Specs](docs/specs/README.md) | Every feature with EARS acceptance criteria, design and tasks |
| 🛡️ [Threat model](docs/threat-model.md) | STRIDE analysis and mitigations |
| 🚢 [Deploy runbook](docs/deploy.md) | Releases, published images, production Compose, Terraform for Oracle Cloud Always Free |
| 📝 [Changelog](CHANGELOG.md) | Changes in every released version |
| 💰 [Budgets guide](docs/budgets.md) | Prices, cost per request, budgets, headers, overshoot bound, Redis failure policy |
| 🔐 [PII redaction guide](docs/pii.md) | Modes, detectors, placeholders, headers and limits of `mask` / `block` |
| 📊 [Observability guide](docs/observability.md) | Dashboards, alert rules, metric and span reference, duration and overhead definitions, demo traffic |
| 📈 [Benchmarks](docs/benchmarks.md) | k6 method, how to run and publish, and the generated results (none until a clean run is committed) |

## 🤝 Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: larger changes start as a spec in `docs/specs/`.

## 📄 License

[MIT](LICENSE) © Thiago Sanches
