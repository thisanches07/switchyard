# 0014. Validate with Zod; use Fastify route schemas only for OpenAPI documentation

- **Status:** Proposed
- **Date:** 2026-10-13
- **Related specs:** 004

## Context
Spec 004 adds an OpenAPI document at `/docs`. `@fastify/swagger` builds it from Fastify route `schema` objects, but Fastify also uses those schemas to **validate** requests (Ajv) and to **serialise** responses (fast-json-stringify). The gateway already validates everything with Zod (readable field paths such as `messages[0].role`, typed results), and `/v1` responses are provider bodies that must be passed through untouched: a response schema would silently drop unknown fields.

## Options considered
1. **Zod for validation, route schemas as documentation only** (no-op validator and serializer compilers): one validator, untouched passthrough, docs still generated.
2. **Ajv via route schemas for validation**: native Fastify path, but two validation styles, different error messages, and response schemas risk stripping provider fields.
3. **`fastify-type-provider-zod`** to derive JSON Schema from Zod: single source, but adds a dependency whose Zod 4 support and OpenAPI output must be tracked, for a small API.

## Decision
Zod stays the only validator. Route `schema` objects describe requests for OpenAPI only; the app installs no-op validator and serializer compilers, so Fastify neither validates nor reshapes payloads.

## Consequences
- ✅ One validation path and error format; provider responses are never filtered.
- ⚠️ Route schemas and Zod schemas can drift; `test/unit/app/openapi.test.ts` checks the documented paths, and both live next to each other in each module.
- 🔁 Revisit with option 3 if the API grows enough that keeping two descriptions in sync becomes costly.
