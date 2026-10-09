# 0004. Use a canonical internal format with provider adapters

- **Status:** Proposed
- **Date:** 2026-10-09
- **Related specs:** 002, 003, 008, 014

## Context
Providers differ in request shape, streaming events, tool-call encoding, usage reporting and errors. Features such as caching, PII redaction and cost accounting must work the same regardless of provider.

## Options considered
1. **Canonical request/response/chunk types + one adapter per provider family**: features operate on one shape; adding a provider means one adapter.
2. **Pass-through with per-feature provider branches**: no translation cost, but every feature grows N branches (N×M complexity).
3. **Depend on a third-party abstraction (e.g. Vercel AI SDK core, LiteLLM)**: less code, but hides exactly the engineering this project wants to demonstrate and couples us to their release cycle.

## Decision
Define canonical types in `src/core` (`ChatRequest`, `ChatResponse`, `ChatChunk`, `Usage`, `ProviderError`) closely modelled on the OpenAI shape. Implement adapters: `openai-compatible` (OpenAI, Groq, Gemini OpenAI endpoint, OpenRouter, Ollama), `anthropic` and `mock`. Adapters also normalise errors into retryable / non-retryable classes used by the router.

## Consequences
- ✅ Features are provider-agnostic and unit-testable with the mock adapter.
- ✅ OpenAI-compatible providers cost almost nothing to add (config only).
- ⚠️ Translation is lossy for provider-specific features; unsupported params are documented and either dropped or rejected with a clear 400.
- 🔁 Revisit if a provider's unique features become a core requirement.
