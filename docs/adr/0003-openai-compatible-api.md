# 0003. Expose an OpenAI-compatible API as the public surface

- **Status:** Accepted
- **Date:** 2026-10-09
- **Related specs:** 002, 003, 014

## Context
Adoption depends on friction. Most LLM client code in the wild uses the OpenAI SDK or an OpenAI-compatible client (LangChain, Vercel AI SDK, LiteLLM clients, Ollama).

## Options considered
1. **OpenAI-compatible (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`)**: zero-code adoption by changing `baseURL`; huge client ecosystem.
2. **Own API design**: freedom to model routing hints cleanly, but every client needs a custom SDK.
3. **Anthropic Messages API as primary**: richer content blocks, smaller client ecosystem.

## Decision
The public surface is **OpenAI-compatible**, including the OpenAI error shape and SSE streaming format. Switchyard-specific behaviour is exposed through `x-switchyard-*` headers, never through incompatible body fields. An Anthropic-compatible `/v1/messages` endpoint is a stretch goal (spec 014).

## Consequences
- ✅ Official SDKs work unchanged; contract tests with them become our compatibility guarantee.
- ⚠️ We must track OpenAI API changes (new params, `stream_options`, tool call formats).
- ⚠️ Unknown request fields are passed through to OpenAI-compatible providers but may be dropped for others; this is documented per adapter.
- 🔁 Revisit if a vendor-neutral standard API gains broad SDK support.
