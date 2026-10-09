# 0002. Use Node.js 24 LTS, TypeScript (strict) and Fastify 5

- **Status:** Proposed
- **Date:** 2026-10-09
- **Related specs:** 001, 002, 003

## Context
The gateway is a hot-path proxy: every millisecond of overhead and every stream chunk matters. It must handle many concurrent long-lived streaming connections with low memory. The project is also a portfolio piece targeting senior Node.js backend roles.

## Options considered
1. **Fastify 5 + undici**: very low overhead, hooks map naturally to the request pipeline (auth → limits → budget → PII → cache → route), JSON schema validation, mature plugin system. Less "batteries included" than NestJS.
2. **NestJS (on Fastify adapter)**: strong structure, DI and modules. Adds abstraction and decorators on a path where we want explicit control over streams and backpressure.
3. **Hono / plain `node:http`**: Hono is fast and portable but its Node ecosystem (plugins, OTel instrumentation) is thinner; plain `node:http` means rebuilding routing, validation and lifecycle.
4. **Go**: excellent fit for proxies, but outside the goal of demonstrating senior Node.js.

## Decision
Use **Node.js 24 LTS**, **TypeScript strict**, **Fastify 5** for the HTTP server and **undici** for upstream calls. Dependency injection is done manually through a typed `buildApp(deps)` factory instead of a DI container.

## Consequences
- ✅ Low overhead, first-class streaming, good OpenTelemetry instrumentation.
- ✅ Explicit pipeline is easy to reason about and test.
- ⚠️ We own the structure that NestJS would give for free; `CLAUDE.md` architecture rules compensate.
- 🔁 Revisit if benchmarks (spec 012) show framework overhead dominating p95.
