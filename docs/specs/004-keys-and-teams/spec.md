# Spec 004: Virtual API keys, teams and the admin API

- **Status:** Approved (2026-10-13)
- **Owner:** @thisanches07
- **Release:** v0.1
- **Depends on:** 002, 003
- **Related ADRs:** 0003 (OpenAI-compatible API), 0005 (Postgres + Drizzle), 0010 (no secrets in logs), 0011 (OpenTelemetry)

## Problem
Anyone who can reach the gateway can spend the operator's provider credits: `/v1/*` has no authentication, which is why Compose binds every port to `127.0.0.1`. Limits, budgets and usage accounting (specs 005–007) also need to know *who* is calling. Switchyard needs its own **virtual API keys**, grouped into **teams**, that clients send exactly like an OpenAI key, plus an admin API to manage them. This is also the first spec that stores data in Postgres, so it introduces schema migrations.

## User stories
- As an **operator**, I want to create teams and issue keys per application, so I can tell callers apart and revoke one without affecting others.
- As an **application developer**, I want to pass my Switchyard key as the OpenAI `apiKey`, so no client code changes.
- As an **operator**, I want to restrict a key to certain models, so a cheap internal tool cannot call an expensive model.
- As a **security reviewer**, I want keys stored only as hashes and never logged, so a database or log leak does not expose usable keys.

## Acceptance criteria (EARS)

### Data and migrations
- **AC-1** WHEN `pnpm db:migrate` runs, or the gateway starts with `MIGRATE_ON_BOOT=true` (the Compose default), THE system SHALL apply pending SQL migrations that create the `teams` and `api_keys` tables, and SHALL be idempotent when run again.

### Keys
- **AC-2** WHEN a key is created, THE gateway SHALL generate `sk-sy-` followed by at least 32 bytes of randomness (base62), return the plaintext **once** in the creation response, and store only `SHA-256(KEY_PEPPER + key)` plus a non-secret display prefix (first 10 characters).
- **AC-3** WHEN a request to any `/v1/*` route carries `Authorization: Bearer <key>` for an active, unexpired key, THE gateway SHALL process it and attach the key id and team id to the request (logs, span attributes `switchyard.team_id` / `switchyard.key_id`, and a `team` label on `switchyard_requests_total`).
- **AC-4** IF the `Authorization` header is missing or malformed, or the key is unknown, revoked or expired, THEN THE gateway SHALL respond `401` with `{"error":{"type":"invalid_request_error","code":"invalid_api_key",…}}` and SHALL NOT call any provider. `/healthz` and `/readyz` stay unauthenticated.
- **AC-5** WHERE a key has a non-empty `allowedModels` list, THE gateway SHALL accept a request only if the requested `model` or its resolved `provider/model` is in the list, otherwise respond `403` with `code: "model_not_allowed"`; and `GET /v1/models` SHALL list only the models that key may use.
- **AC-6** WHEN a key is validated, THE gateway SHALL cache the result in memory for at most 30 s; WHEN a key is revoked through the admin API, THE same instance SHALL reject it immediately, and other instances SHALL reject it within 30 s.

### Admin API
- **AC-7** WHEN `ADMIN_TOKEN` is configured, THE gateway SHALL expose, behind `Authorization: Bearer <ADMIN_TOKEN>` (compared in constant time):
  - `POST /admin/teams`, `GET /admin/teams`
  - `POST /admin/keys` (`teamId`, `name`, optional `allowedModels`, optional `expiresAt`), `GET /admin/keys?teamId=`, `POST /admin/keys/:id/revoke`
  
  Listing never returns hashes or plaintext keys. Validation errors return `400`, unknown ids `404`, duplicate team names `409`, all in the OpenAI error shape.
- **AC-8** IF the admin token is missing or wrong, THEN admin routes SHALL respond `401`; IF `ADMIN_TOKEN` is not configured, THEN admin routes SHALL respond `404` and the gateway SHALL log a warning at boot.
- **AC-9** IF `KEY_PEPPER` is missing or shorter than 32 characters, THEN the gateway SHALL refuse to start with a readable configuration error.

### Docs and compatibility
- **AC-10** THE gateway SHALL serve an OpenAPI 3 document at `/docs/json` and an interactive UI at `/docs`, covering the admin API and the `/v1` routes.
- **AC-11** WHEN the contract suites run, THE official OpenAI Node and Python SDKs SHALL authenticate with a key created through the admin API, and an invalid key SHALL surface as the SDK's `AuthenticationError`.
- **AC-12** THE Compose smoke test SHALL create a team and a key through the admin API and complete a chat request with that key, and SHALL verify that a request without a key gets `401`.

## Non-goals
- Rate limits per key (spec 005), budgets (spec 007), usage events and `last_used_at` tracking (spec 006).
- User accounts, SSO or a web admin UI.
- Key rotation workflows beyond create + revoke.
- Scoped admin tokens: a single operator token in this spec.

## Open questions
- Should migrations run automatically at boot in production too? (Proposed: `MIGRATE_ON_BOOT` defaults to `false` outside Compose; the deploy in spec 013 runs `pnpm db:migrate` as a release step.)
- Should Compose ship insecure default `ADMIN_TOKEN`/`KEY_PEPPER` values so `docker compose up` works without setup? (Proposed: yes, clearly named `dev-only-…`, with a warning log when they are in use; ports stay bound to `127.0.0.1`.)
