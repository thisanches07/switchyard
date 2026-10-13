# Threat model

> Living document (STRIDE). Each spec that touches a listed asset updates the relevant rows.

## Assets
- Provider API keys (in env / secret store)
- Switchyard virtual keys and the admin token
- Prompt and response content in transit
- Semantic cache entries (stored responses)
- Budgets and usage data

## Threats and mitigations

| STRIDE | Threat | Mitigation | Spec |
|---|---|---|---|
| Spoofing | Stolen or guessed virtual key | High-entropy keys, hashed at rest with pepper, constant-time compare, revocation, per-key limits | 004, 005 |
| Spoofing | Admin API abuse | Separate admin token, admin routes can be bound to a private interface | 004 |
| Tampering | Malicious config (e.g. provider URL pointing to attacker) | Config is operator-owned, validated with Zod, never accepted from requests | 001, 008 |
| Repudiation | Disputed usage/cost | One usage event per admitted request, carrying the `x-switchyard-request-id` returned to the client, team and key ids, timestamps, tokens and outcome. Events are **insert-only** (no update or delete API or code path), metadata-only (strict schema, ADR-0010) and stored **effectively once** (UUIDv7 id + `ON CONFLICT DO NOTHING`, aggregates updated in the same transaction). Residual risk: during a broker outage longer than the in-memory buffer (`usage.bufferSize`), events are dropped; every drop is counted in `switchyard_usage_events_dropped_total{reason}` (ADR-0007) | 006 |
| Information disclosure | Cross-tenant answers through the semantic cache | Cache scoped by team + model + params; explicit isolation test | 009 |
| Information disclosure | PII sent to third-party providers | PII redaction per key (`mask`: typed placeholders restored in answers; `block`: `400 pii_detected`) for e-mail, phone, card, CPF, CNPJ, IP and deny-list terms, validated by check digits / Luhn / address parsers; values and the placeholder map stay in request memory only (never logged, traced, cached or stored). Residual: names and free-text identifiers are not detected; streamed answers keep placeholders until spec 015; the provider learns which types are present ([guide](pii.md)) | 010 |
| Information disclosure | Content leaking via logs or traces | Content never logged; span attributes sanitized | 001, 011 |
| Denial of service | Request floods or huge bodies | Body size limits, timeouts, RPM/TPM limits | 001, 005 |
| Denial of service | Budget exhaustion ("denial of wallet"): a leaked or runaway key running up the provider bill | Monthly hard budgets per key and team, checked before any provider call (`429 budget_exceeded`, no rate-limit units used), soft-limit warning and `switchyard_budget_used_ratio` for alerts; spend kept in Redis across instances and repaired from Postgres by reconciliation; budgeted keys fail closed when Redis is down (default). Residual: requests in flight when a budget runs out still finish (overshoot bounded by their cost, [guide](budgets.md)); models with an unknown (`TODO`) price are not limited, which the boot warning and `switchyard_cost_unknown_requests_total` make visible; public demo uses capped keys | 007, 013 |
| Elevation of privilege | Key used for models it isn't allowed | Allowed-models check after alias resolution | 004, 008 |

## Out of scope (documented, not mitigated)
- Prompt injection against downstream apps: the gateway does not interpret prompts.
- Compromise of the host or of provider accounts.
