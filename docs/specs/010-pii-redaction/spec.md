# Spec 010: PII redaction (mask and block)

- **Status:** Draft
- **Owner:** @thisanches07
- **Release:** v0.2
- **Depends on:** 004 (implemented in wave A, in parallel with 006 and 014; merges **after 006** and adds `piiDetections` through 006's request-outcome hook, see `docs/specs/waves.md`)
- **Related ADRs:** 0015 (PII detection and reversible placeholders, proposed with this spec), 0010 (no prompt persistence), 0008 (no retry after first byte), 0011 (OpenTelemetry)

## Problem
Every prompt that goes through Switchyard is forwarded to a third-party provider. Prompts routinely carry personal data: customer e-mails, phone numbers, card numbers pasted into support tickets and, for Brazilian users, CPF and CNPJ numbers. Under LGPD and GDPR, sending that data to a provider is a transfer the operator has to justify, and most applications calling the gateway were never written to scrub it. The threat model already lists "PII sent to third-party providers" as an open risk owned by this spec.

The gateway is the one place every request passes through, so it is the cheapest place to:
- **detect** common personal identifiers with validators (check digits, Luhn) instead of naive patterns, so false positives stay rare;
- **mask** them before the provider sees them, with placeholders like `<CPF_1>` that keep the prompt meaningful to the model, and **restore** the original values in the answer so the application never notices;
- **block** a request outright when the operator prefers refusing to masking;
- do all of this **without** turning the gateway into a new place where the data leaks (logs, spans, events, caches).

Restoring placeholders inside a streamed response is hard (a placeholder can be split across chunks) and is deliberately left to spec 015. In this spec, streamed requests are masked like any other, but the streamed answer keeps the placeholders, and the client can see that it does.

## User stories
- As an **operator**, I want to turn on masking for a key, so personal data in its prompts never reaches the provider while the application keeps working unchanged.
- As an **operator**, I want a `block` mode for keys whose callers must never send personal data, so a mistake is refused instead of silently rewritten.
- As an **operator**, I want a default mode in config and an override per key, so I can roll redaction out gradually.
- As an **operator**, I want my own deny-list of terms (project code names, customer names), so domain-specific secrets get the same treatment.
- As an **application developer**, I want non-streaming answers to contain the original values again, and a header that tells me when a streamed answer still contains placeholders.
- As a **security reviewer**, I want proof that original values never appear in logs, spans, usage events or metrics.

## Concepts
- **Detector types** (one canonical list, used for placeholder prefixes, the metric `type` label, `piiDetections` keys and the `pii_detected` error): `email`, `phone`, `card`, `cpf`, `cnpj`, `ip`, `term`.
  - `email`: RFC 5322 "common subset" addresses (`local@domain.tld`).
  - `phone`: Brazilian numbers (landline and mobile, with or without `+55`, DDD in parentheses or not, separators optional) and international numbers in E.164 (`+` followed by 8 to 15 digits).
  - `card`: 13 to 19 digits, optionally grouped by spaces or hyphens, **passing the Luhn check**.
  - `cpf`: 11 digits, formatted (`529.982.247-25`) or not (`52998224725`), **passing both check digits**, excluding repeated-digit sequences.
  - `cnpj`: 14 digits, formatted (`11.222.333/0001-81`) or not (`11222333000181`), **passing both check digits**, excluding repeated-digit sequences.
  - `ip`: IPv4 (four octets 0–255) and IPv6 (full, compressed and IPv4-mapped forms, validated by a parser, not by a pattern alone).
  - `term`: entries of `pii.denyList`, matched as **literal** terms (never as regular expressions), case-insensitive, on word boundaries.
- **Mode** per key: `off` (no scanning at all), `mask` (replace and restore), `block` (refuse). Effective mode = `api_keys.pii_mode`, else `pii.defaultMode`, else `off`.
- **Placeholder:** `<TYPE_n>`, with `TYPE` the upper-cased detector type and `n` a counter per type starting at 1 within one request, e.g. `<CPF_1>`, `<EMAIL_2>`, `<TERM_1>`. The same exact matched string gets the same placeholder everywhere in the request.
- **Restore map:** placeholder → original string, built while masking. It lives only in the memory of the request that built it and is discarded when the request ends.
- **Inspected fields** (both `mask` and `block`):
  - chat: `messages[].content` of **every role** (`system`, `developer`, `user`, `assistant`, `tool`), whether a string or an array (only `type: "text"` parts), and `messages[].tool_calls[].function.arguments` of earlier assistant turns;
  - embeddings: `input` when it is a string or an array of strings.
  - **Not inspected:** image, audio and file parts; `tools` / `functions` definitions (operator- or developer-authored schemas); message `name`; token-array embeddings input; every other request parameter.
- **Detections** are counted as occurrences (two copies of the same CPF count 2), per type.

## Acceptance criteria (EARS)

### Configuring modes
- **AC-1** THE schema SHALL add a nullable `pii_mode` column (enum `off` / `mask` / `block`, `NULL` = config default) to `api_keys` via migration `0003_pii_mode`, and the config file SHALL accept `pii.defaultMode` (default `off`), `pii.detectors` (list of detector types, default all) and `pii.denyList` (list of non-empty literal strings, default empty). An unknown detector type or mode SHALL fail config validation at startup.
- **AC-2** WHEN an operator creates a key with `POST /admin/keys` or sends `PATCH /admin/keys/:id`, THE admin API SHALL accept an optional `piiMode` (`"off"`, `"mask"`, `"block"`, or `null` to fall back to the default) and return it in key responses; an invalid value SHALL get `400`. A change SHALL apply to new requests on the same instance immediately and on other instances within 30 s, like limits in spec 005.

### Detection
- **AC-3** WHEN a key's effective mode is `mask` or `block`, THE gateway SHALL detect, in the inspected fields, at least these vectors: `ana.silva@example.com` (`email`); `(11) 98765-4321`, `+55 11 98765-4321`, `11987654321` and `+14155552671` (`phone`); `4111 1111 1111 1111` and `4111111111111111` (`card`); `529.982.247-25` and `52998224725` (`cpf`); `11.222.333/0001-81` and `11222333000181` (`cnpj`); `192.168.0.1` and `2001:db8::1` (`ip`); and a configured deny-list term in any letter case (`term`). Detector types not listed in `pii.detectors` SHALL NOT run.
- **AC-4** THE detectors SHALL NOT report these false-positive vectors: `4111 1111 1111 1112` (fails Luhn); `529.982.247-26` and `52998224726` (wrong CPF check digit); `111.111.111-11` and `00000000000` (repeated digits); `11.222.333/0001-82` (wrong CNPJ check digit); `999.1.1.1` and `256.0.0.1` (invalid octets); `12:30:45` (a time, not IPv6); a deny-list term embedded in a longer word (`acme` inside `acmeville`).
- **AC-5** WHEN matches overlap, THE gateway SHALL keep the longest match, break ties in favour of validator-backed types (`card`, `cpf`, `cnpj`) over pattern-only ones, and replace each character at most once; e.g. `11987654321` is a `phone` because it fails the CPF check, while `52998224725` is a `cpf`.
- **AC-6** THE detection of one request SHALL run in time linear in its input: every pattern SHALL be free of nested or overlapping unbounded quantifiers (enforced by a unit test over the detector definitions), and scanning adversarial inputs of `server.bodyLimitBytes` (1 MiB by default), such as one long run of digits, `a@` repeated, `1.` repeated and `:` repeated, SHALL complete in under 500 ms each on the CI runner.

### Mask mode
- **AC-7** WHEN the effective mode is `mask`, THE gateway SHALL replace every detection in the inspected fields with its placeholder **after** authentication, model authorization and rate-limit admission and **before** the request reaches the cache key computation (spec 009) or any provider, so that a provider fake captures a request containing `<CPF_1>` and not `529.982.247-25`. The same exact string SHALL map to the same placeholder in every message of the request, and the rest of the request SHALL be forwarded unchanged.
- **AC-8** WHEN a masked chat request is **non-streaming**, THE gateway SHALL replace every known placeholder in `choices[].message.content` and `choices[].message.tool_calls[].function.arguments` of every choice with its original string (JSON-escaped inside arguments, so arguments that were valid JSON stay valid), SHALL leave unknown or altered placeholders (`<CPF_9>`, `<cpf_1>`, `CPF_1`) untouched, and SHALL respond with `x-switchyard-pii: masked`. Embeddings responses carry no text and need no restore.
- **AC-9** WHEN a masked chat request is **streaming**, THE gateway SHALL mask the request as in AC-7 but SHALL forward the response chunks without restoring placeholders, and SHALL send `x-switchyard-pii: masked-unrestored` with the stream headers. THE README and the PII guide SHALL state this limitation and point to spec 015.
- **AC-10** WHEN the effective mode is `mask` or `block` and nothing is detected, THE response SHALL carry `x-switchyard-pii: none`; WHEN the mode is `off`, THE gateway SHALL NOT scan the request and SHALL NOT send the header.

### Block mode
- **AC-11** WHEN the effective mode is `block` and at least one detection is found, THE gateway SHALL respond `400` with `{"error":{"type":"invalid_request_error","code":"pii_detected","message":"…"}}` whose message lists the detected **types** in canonical order (e.g. `cpf, email`) and never a value or position, SHALL NOT call any provider, and SHALL refund the whole token reservation while keeping the request unit (spec 005 AC-6 semantics). This applies to chat (streaming or not) and embeddings.

### Privacy and observability
- **AC-12** THE original values and the restore map SHALL exist only in the memory of the request: they SHALL NOT be written to logs at the most verbose level, to span attributes or events, to metrics labels, to usage events, to Redis or to Postgres. A test SHALL capture all log lines and exported spans of `mask` and `block` requests carrying every AC-3 vector and assert that none of the vectors appears in them.
- **AC-13** FOR every scanned request, THE gateway SHALL increment `switchyard_pii_detections_total{type}` by the occurrences per type, add `switchyard.pii.mode`, `switchyard.pii.action` (`none` / `masked` / `blocked`) and `switchyard.pii.detections` (total count) to the request span, and fill `piiDetections` (`{ type: count }`, `{}` when nothing was found or the mode is `off`) in the request's `UsageEvent` through spec 006's outcome hook, for blocked requests too.

### Tests
- **AC-14** THE OpenAI Node SDK contract tests SHALL show that a `block` key gets a `BadRequestError` with code `pii_detected`, and THE Compose smoke test SHALL create a `block` key, send a prompt containing `529.982.247-25` and observe `400` `pii_detected`, then create a `mask` key and observe `200` with `x-switchyard-pii: masked`.

## Non-goals
- Detecting PII in **responses** that was not in the request (the model inventing or recalling personal data).
- Named-entity recognition (person names, addresses, free-form identifiers) or ML-based detection; see ADR-0015.
- Restoring placeholders in streaming responses (spec 015).
- A team-level PII mode; per-key detector selection; per-key deny-lists.
- Inspecting images, audio, files, tool definitions or token-array inputs.
- Regular-expression deny-list entries (a ReDoS vector; terms are literals).
- Content logging with redaction (ADR-0010 opt-in logging is not part of this spec).

## Open questions
- Should `529.982.247-25` and `52998224725` in the same request share one placeholder? (Proposed: no; identity is the exact matched string, which keeps restore lossless. Normalising by type is a possible follow-up if models get confused.)
- Which `outcome` does the 006 `UsageEvent` carry for a blocked request? (Resolved: `rejected` was added to the enum in `waves.md` and spec 006; blocked requests are emitted with `outcome: "rejected"`, `status: 400`, `errorCode: "pii_detected"`, `provider: null` and `attempts: 0`.)
- What if the client's own text already contains a string that looks like a placeholder, such as `<CPF_1>`? (Proposed: numbering skips any `<TYPE_n>` already present in the inspected fields, so restore never rewrites the client's literal text.)
- Brazil introduced the **alphanumeric CNPJ** (letters in the first 12 positions) in 2026. Should the `cnpj` detector accept it? (Proposed: yes, using the official check-digit rule on ASCII values minus 48, with valid and invalid vectors in tests.)
- How does an end-to-end test prove restore without a real model? (Proposed: unit and app-level tests use an injected provider fake that echoes placeholders; add an `echo` model to the mock provider so the smoke test can also assert the restored value.)
- How does masking interact with caching (spec 009)? (Proposed: the cache key is computed on the masked request and the stored response keeps placeholders; restore runs per request, also on cache hits. 009's design must state this.)
- Does `/v1/messages` (spec 014) get redaction? (Proposed: yes; 014 translates to the canonical request, so it calls the same PII stage after admission. Whichever of 010 and 014 merges second wires it in.)
- Should token-array embeddings input be refused in `block` mode, since it cannot be inspected? (Proposed: no; pass it through, record `switchyard.pii.uninspected=true` on the span and document it.)
