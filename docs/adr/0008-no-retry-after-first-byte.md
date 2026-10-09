# 0008. Never retry or fall back after the first streamed byte

- **Status:** Proposed
- **Date:** 2026-10-09
- **Related specs:** 003, 008

## Context
With streaming, the gateway forwards chunks as soon as they arrive. If the upstream fails mid-stream, retrying on another provider would send the client a second, different answer appended to a partial one.

## Options considered
1. **Retry/fallback only before the first byte is sent to the client**; after that, terminate the stream with an error event.
2. **Buffer the whole response before sending**: makes retries safe but destroys time-to-first-token, the main reason to stream.
3. **Retry mid-stream and try to "continue" the answer**: unreliable and produces incoherent output.

## Decision
Retries and fallback happen **only until the first chunk is written to the client**. After that, an upstream failure ends the stream with an OpenAI-style error event, the usage event is recorded with `status = upstream_error_midstream`, and the circuit breaker counts the failure.

## Consequences
- ✅ Clients never receive duplicated or spliced answers.
- ⚠️ Mid-stream failures surface to the client; they are measured so we can see how often it happens.
- 🔁 Revisit if a provider offers resumable streams.
