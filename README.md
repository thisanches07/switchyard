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
> **Status: v0.1 in progress.** Chat completions (including **SSE streaming**), embeddings, model listing, provider adapters, error mapping, tracing and metrics are **working and tested today**, plus **virtual API keys with teams**, an admin API, **per-minute rate limits** shared across instances and a **usage event pipeline** (Kafka → idempotent worker → Postgres), contract-tested with the official OpenAI Node and Python SDKs. Budgets, fallback and caching are specified and on the [roadmap](#%EF%B8%8F-roadmap).

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
| 🔭 | `switchyard.upstream` spans with GenAI attributes, request and latency metrics, `x-switchyard-*` headers | ✅ |
| ❤️ | `/healthz`, `/readyz` with time-bounded dependency checks, graceful shutdown | ✅ |
| 🔑 | **Virtual API keys** (`sk-sy-…`, stored only as peppered hashes), teams, per-key model allow-lists, revocation | ✅ |
| 🚥 | **Rate limits** in requests and tokens per minute, per key and per team, atomic in Redis (Lua), OpenAI-style `429` + `x-ratelimit-*` | ✅ |
| 🛠️ | Admin API for teams and keys; OpenAPI document and interactive UI at `/docs` | ✅ |
| 📨 | **Usage events** through Kafka (Redpanda): never blocks a request, idempotent worker, daily aggregates, DLQ, `GET /admin/usage` | ✅ |
| 💰 | Monthly budgets with soft and hard limits | 🔜 007 |
| 🛟 | Fallback, retries with jitter, circuit breakers | 🔜 008 |
| ⚡ | Exact cache and tenant-scoped semantic cache (pgvector) | 🔜 009 |
| 🛡️ | PII redaction with reversible masking | 🔜 010 |

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
    RES --> LIM --> AD["Provider adapter<br/>timeouts · error mapping"]
    LIM["Rate limits<br/>Redis token buckets"]
    BUD["Budgets"]:::planned
    CACHE["Cache · PII"]:::planned
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
  G->>P: POST {baseUrl}/chat/completions (model rewritten)
  Note over G,P: span switchyard.upstream<br/>connect · TTFB · total timeouts
  alt 2xx
    P-->>G: chat.completion + usage
    G-->>C: 200 body + x-switchyard-provider / -model / -upstream-ms
  else 4xx
    P-->>G: provider error
    G-->>C: same status, OpenAI error shape
  else 5xx · network error · timeout
    G-->>C: 502 upstream_error / 504 upstream_timeout
  end
  G->>G: record one usage event (buffered, published to Kafka in the background)
```

### Model resolution

```mermaid
flowchart TD
  M["model in the request"] --> A{"Is it an alias?<br/>(local, fast, smart…)"}
  A -- yes --> F["First candidate of the alias<br/>e.g. ollama/llama3.2"]
  A -- no --> S{"provider/model with a<br/>configured provider?"}
  S -- yes --> D["That provider, model kept as-is<br/>openrouter/meta-llama/llama-3.3-70b"]
  S -- no --> N["404 model_not_found"]
  F --> CALL["Call the provider adapter"]
  D --> CALL
```

### Error contract

Every error, from validation to provider failures, comes back in the OpenAI shape, so SDKs raise their usual typed exceptions (`NotFoundError`, `RateLimitError`, …).

| Situation | Status | `code` |
|---|:---:|---|
| Invalid JSON or body | 400 | `invalid_json` / `invalid_request` |
| Missing, unknown, revoked or expired API key | 401 | `invalid_api_key` |
| Model outside the key's allow-list | 403 | `model_not_allowed` |
| Over a request or token limit (key, team or failed-auth address) | 429 | `rate_limit_exceeded` (`type`: `requests` or `tokens`) |
| A single request needs more tokens than the per-minute limit | 400 | `request_too_large_for_limit` |
| Redis down with `limits.onRedisError: closed` | 503 | `rate_limiter_unavailable` |
| Unknown model | 404 | `model_not_found` |
| Body too large / not JSON | 413 / 415 | `request_too_large` / `unsupported_media_type` |
| Provider 4xx (e.g. 429) | same | passed through |
| Provider 5xx, connection refused, invalid response | 502 | `upstream_error` (provider body never forwarded) |
| Provider timeout | 504 | `upstream_timeout` |
| Provider configured without its API key | 503 | `provider_not_configured` |

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
| `REDIS_URL` | required | Redis (`redis://…`) |
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
| `POST` | `/admin/teams` | Create a team `{ name, rpm?, tpm? }` |
| `GET` | `/admin/teams` | List teams |
| `POST` | `/admin/keys` | Create a key `{ teamId, name, allowedModels?, expiresAt?, rpm?, tpm? }`; the plaintext key is returned **only here** |
| `GET` | `/admin/keys?teamId=` | List keys (prefix, status, limits; never the key or its hash) |
| `PATCH` | `/admin/keys/:id` | Set or clear (`null`) the key's `rpm` / `tpm` |
| `PATCH` | `/admin/teams/:id` | Set or clear the team's `rpm` / `tpm` caps |
| `POST` | `/admin/keys/:id/revoke` | Revoke a key; rejected immediately on this instance, everywhere within 30 s |
| `GET` | `/admin/usage?from=&to=&groupBy=&teamId=&keyId=` | Requests, tokens and cost per team, key, model, provider or day ([usage](#-usage-events)) |

`allowedModels` accepts aliases (`fast`), exact refs (`ollama/llama3.2`) and provider wildcards (`ollama/*`); `/v1/models` then lists only what the key may use. Admin routes take `Authorization: Bearer <ADMIN_TOKEN>` and do not exist at all when `ADMIN_TOKEN` is unset.

📖 The full API, including request bodies, is documented in OpenAPI at **<http://localhost:8080/docs>**.

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
      "costUsd": "0", "unknownCostRequests": 42 }
  ],
  "totals": { "requests": 42, "inputTokens": 5120, "outputTokens": 9310, "costUsd": "0", "unknownCostRequests": 42 }
}
```

`groupBy` is `team`, `key`, `model`, `provider` or `day` (default; `from`/`to` default to the last 30 days, at most 366). Costs stay `null` (counted in `unknownCostRequests`) until budgets land in spec 007. Results are eventually consistent: a request shows up within seconds. Set `usage.enabled: false` to run without Kafka.

## 🔭 Observability

Every response tells you what happened:

```http
HTTP/1.1 200 OK
x-switchyard-request-id: req_5b9e1fd5-2c46-4adf-b99a-dbf336c523aa
x-switchyard-provider: ollama
x-switchyard-model: llama3.2
x-switchyard-upstream-ms: 986
```

| Signal | Name | Details |
|---|---|---|
| Span | `switchyard.upstream` | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens` / `output_tokens` |
| Counter | `switchyard_requests_total` | by `provider`, `model`, `status`, `team` |
| Histogram | `switchyard_upstream_duration_seconds` | by `provider`, `model`, `outcome` |
| Histogram | `switchyard_ttfb_seconds` | time to first streamed token, by `provider`, `model` |
| Counter | `switchyard_ratelimit_rejections_total` | by `scope` (`key`, `team`, `ip`) and `kind` (`requests`, `tokens`) |
| Counter | `switchyard_auth_failures_total` | rejected `/v1` requests by `reason` (`missing`, `malformed`, `unknown`, `revoked`, `expired`) |
| Counters | `switchyard_usage_events_published_total`, `switchyard_usage_events_dropped_total` | usage events acknowledged by Kafka; dropped by `reason` (`buffer_full`, `shutdown`, `invalid`) |
| Gauge | `switchyard_usage_buffer_events` | usage events waiting in the gateway's buffer |
| Counter | `switchyard_usage_worker_events_total` | worker results: `inserted`, `duplicate`, `dlq` |
| Span | `switchyard.usage.consume` | one per worker batch, with message and result counts |
| Logs | JSON (pino) | every line carries `trace_id` / `span_id`, plus `teamId` / `keyId` once authenticated; secrets redacted |

> [!IMPORTANT]
> Prompt and response **content is never written to logs or spans** ([ADR-0010](docs/adr/0010-no-prompt-persistence.md)). Only metadata such as tokens, latency and status is recorded.

**See a trace:** open Grafana at <http://localhost:3000> → **Explore** → **Tempo** → search service `switchyard-gateway`.

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
| `pnpm test:contract` | The **official OpenAI Node SDK** against the gateway: chat, streaming, embeddings (mock always; Ollama when running) |
| `pnpm db:migrate` | Applies database migrations to `DATABASE_URL` (`pnpm db:generate` creates new ones from the Drizzle schema) |
| `pnpm test:contract:py` | The same with the **official OpenAI Python SDK** (needs `pip install -r test/contract/python/requirements.txt`) |
| `pnpm test:smoke` | Boots the Compose stack: health, readiness, a chat request, rate limits, a request counted in `GET /admin/usage`, bad config, memory budget, graceful SIGTERM |

```mermaid
flowchart LR
  PR["Pull request"] --> V["verify<br/>lint · types · unit + coverage · build"]
  PR --> I["integration<br/>Testcontainers"]
  PR --> S["compose smoke<br/>full stack in Docker"]
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
│  ├─ proxy/            /v1/chat/completions, /v1/models, upstream telemetry
│  ├─ providers/        openai-compatible, mock, registry
│  ├─ routing/          alias and model resolution
│  └─ usage/            request-outcome hook, usage publisher, worker batches, usage reports
└─ infra/               undici HTTP client, Postgres, Redis, Kafka, logger, OpenTelemetry
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
- [ ] 007 Budgets and cost accounting
- [ ] 008 Fallback, retries and circuit breakers

**v0.2: savings and safety:** exact and semantic cache, PII redaction

**v0.3: proof and production:** Grafana dashboards as code, published k6 benchmarks, Terraform deploy

Full scope and dependencies: [spec backlog](docs/specs/README.md).

## 📚 Documentation

| | |
|---|---|
| 🏛️ [Architecture](docs/architecture.md) | Components, request pipeline, data model, failure behaviour |
| 🧾 [Architecture Decision Records](docs/adr/README.md) | Why Fastify, why Kafka, why no retries after the first streamed byte, … |
| 📐 [Specs](docs/specs/README.md) | Every feature with EARS acceptance criteria, design and tasks |
| 🛡️ [Threat model](docs/threat-model.md) | STRIDE analysis and mitigations |
| 📈 [Benchmarks](docs/benchmarks.md) | Method for the k6 benchmarks; numbers are published only once measured |

## 🤝 Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: larger changes start as a spec in `docs/specs/`.

## 📄 License

[MIT](LICENSE) © Thiago Sanches
