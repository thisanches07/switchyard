# PII redaction guide

Switchyard can keep personal data out of the prompts it forwards to third-party providers ([spec 010](specs/010-pii-redaction/spec.md), [ADR-0015](adr/0015-pii-detection-and-reversible-placeholders.md)). This guide covers what is detected, how `mask` and `block` behave, and what redaction does **not** do.

## Modes

| Mode | What happens |
|---|---|
| `off` | Nothing is scanned. No `x-switchyard-pii` header. |
| `mask` | Every detected value is replaced by a placeholder before the provider sees the request, and put back in the answer. |
| `block` | A request containing any detected value is refused with `400 pii_detected`; no provider is called. |

The **effective mode** of a request is the key's own `piiMode`, else `pii.defaultMode` from the config, else `off`.

```yaml
pii:
  defaultMode: off                 # off | mask | block
  detectors: [email, phone, card, cpf, cnpj, ip, term]   # default: all
  denyList: ["Project Falcon", "Acme Corp"]
```

```bash
# A new key that masks
curl -X POST localhost:8080/admin/keys -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"teamId":"…","name":"support-bot","piiMode":"mask"}'

# Switch an existing key to block, or back to the config default
curl -X PATCH localhost:8080/admin/keys/<id> -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"piiMode":"block"}'      # or {"piiMode":null}
```

A change applies immediately on the instance that handled the `PATCH`, and on other instances within 30 s (the authentication cache TTL). An unknown mode or detector type in the config stops the gateway at startup.

## What is detected

| Type | Examples | How false positives are kept rare |
|---|---|---|
| `email` | `ana.silva@example.com` | Domain needs at least two labels and an alphabetic top-level domain |
| `phone` | `(11) 98765-4321`, `+55 11 98765-4321`, `11987654321`, `+14155552671` | Brazilian numbers must use a real area code (DDD); international numbers must be E.164 (`+` and 8 to 15 digits) |
| `card` | `4111 1111 1111 1111`, `4111111111111111` | 13 to 19 digits passing the **Luhn** check; one repeated digit is rejected |
| `cpf` | `529.982.247-25`, `52998224725` | Both **check digits**; repeated digits (`111.111.111-11`) rejected |
| `cnpj` | `11.222.333/0001-81`, `11222333000181`, `12.ABC.345/01DE-35` | Both **check digits**, including the 2026 alphanumeric format (upper case) |
| `ip` | `192.168.0.1`, `2001:db8::1`, `::ffff:192.168.0.1` | Validated by Node's address parser: `999.1.1.1` and `12:30:45` are not addresses |
| `term` | entries of `pii.denyList` | Literal (never a regular expression), case-insensitive, whole words only: `acme` does not match `acmeville` |

When two candidates overlap, the longest wins; on equal length a check-digit type (`cnpj`, `cpf`, `card`) beats a pattern-only one, so `52998224725` is a CPF while `11987654321` (which fails the CPF check) is a phone. Every character is replaced at most once.

Detection is linear in the size of the request (bounded patterns only, tested on adversarial 1 MiB inputs), so it cannot be turned into a denial of service.

### Where the gateway looks

- Chat: `messages[].content` of **every** role, as a string or as `type: "text"` parts, and `messages[].tool_calls[].function.arguments` of earlier assistant turns (string values inside the JSON).
- Embeddings: `input` as a string or an array of strings.
- Anthropic Messages (`/v1/messages`, spec 014): `system`, `text` blocks, `tool_result` text and `tool_use` inputs, through the same canonical fields as chat. On Claude models the masked text is written back into the client's own blocks; `thinking` / `redacted_thinking` blocks (signed by Anthropic) and `document` blocks are forwarded **unscanned** (ADR-0016). Answers are restored, including `tool_use` inputs (streams: see below); thinking in answers is left as sent.
- **Not inspected:** images, audio and files; `tools` / `functions` definitions; message `name`; every other parameter. Token-array embeddings input is passed through unchanged and marked `switchyard.pii.uninspected=true` on the request span.

## Placeholders and restore (`mask`)

Each value becomes `<TYPE_n>`, numbered per type in order of appearance: `<CPF_1>`, `<CPF_2>`, `<EMAIL_1>`, `<TERM_1>`. The same exact string gets the same placeholder everywhere in the request (`529.982.247-25` and `52998224725` are different strings, so they get different placeholders). If the client's own text already contains `<CPF_1>`, numbering continues after it, so restore never rewrites text the client wrote.

The model sees what kind of value is there and can refer back to it. On a **non-streaming** chat answer the gateway replaces every known placeholder in `choices[].message.content` and in tool-call `arguments` (JSON-escaped, so valid JSON stays valid) and sends `x-switchyard-pii: masked`. Embeddings answers carry no text to restore.

Restore is **best-effort**: a placeholder the model reformats (`<cpf_1>`, `CPF 1`) or invents (`<CPF_9>`) is left as it is.

### Streaming ([spec 015](specs/015-pii-streaming-restore/spec.md))

Streamed answers are restored too (`x-switchyard-pii: masked`): `delta.content` and tool-call `arguments`, independently per choice and per tool call. Providers split text anywhere, so a placeholder may arrive as `<CP` + `F_1>` or one character per chunk. The gateway:

- sends text that cannot start a known placeholder **at once** (a stream without `<` keeps exactly its chunk boundaries);
- **holds** only a fragment that could still become a placeholder of this request (`<`, `<CP`, `<CPF_`), and releases it as soon as it completes (restored) or the next character rules it out (`<CPF_9>`, `<cpf_1>`, a literal `<` go out unchanged);
- never holds a fragment longer than `pii.streamRestore.maxHoldMs` (default 250) or `maxHoldChars` characters (default: the longest placeholder): then the fragment is released **unrestored**, in a chunk of its own if the upstream is stalled;
- releases anything still held before the chunk carrying `finish_reason`, before the usage chunk, and before the SSE error event of a mid-stream failure. Usage estimates count the upstream text; nothing changes before the first chunk (retries, fallback, TTFB).

```yaml
pii:
  streamRestore:
    maxHoldMs: 250      # latency wins over restoring a placeholder that is not arriving
    # maxHoldChars: 12  # default: the longest placeholder in the request
```

> [!NOTE]
> On `/v1/messages`, streams served by a **Claude** model are forwarded byte for byte (ADR-0016), so their placeholders are **not** restored and the response says `x-switchyard-pii: masked-unrestored`. Streams served by other providers on `/v1/messages` are restored.

## Blocking (`block`)

```http
HTTP/1.1 400 Bad Request
x-switchyard-pii: blocked

{"error":{"type":"invalid_request_error","code":"pii_detected","message":"Request blocked: personal data detected (cpf, email). Remove it, or ask the operator to use PII mode \"mask\" for this key."}}
```

The message lists detected **types** in alphabetical order, never a value or a position. The request still counts against the key's request rate limit, but its reserved tokens are refunded. The official SDKs raise `BadRequestError` with `code == "pii_detected"`.

## Headers, metrics and spans

| Signal | Values |
|---|---|
| `x-switchyard-pii` | `masked`, `masked-unrestored` (Claude-native `/v1/messages` streams), `none` (scanned, nothing found), `blocked`; absent when the mode is `off` |
| `switchyard_pii_detections_total{type}` | Occurrences found per type, for `mask` and `block` |
| `switchyard_pii_stream_hold_seconds` | Time streamed text was held while it could still be a placeholder (every hold) |
| `switchyard_pii_stream_restore_failures_total{reason}` | Fragments released unrestored; `reason="hold_limit"` |
| Upstream span (streams) | `switchyard.pii.stream_holds`, `switchyard.pii.stream_restore_failures` (counts) |
| Request span | `switchyard.pii.mode`, `switchyard.pii.action` (`none` / `masked` / `blocked`), `switchyard.pii.detections` (total), `switchyard.pii.uninspected` |

Usage events (spec 006) carry `piiDetections` (`{ type: count }`) and blocked requests are recorded with `outcome: "rejected"`.

## Privacy guarantees

Original values and the placeholder map exist **only in the memory of the request** that built them: never in logs (at any level), span attributes or events, metric labels, usage events, Redis or Postgres ([ADR-0010](adr/0010-no-prompt-persistence.md)). A test sends every example above through `mask` and `block` keys with logging at `trace` level and checks that none of them appears in the captured logs, spans or metrics.

## What redaction does not do

- **Names, addresses and free-form identifiers are not detected.** Detection covers the structured identifiers above; add project or customer names to `denyList`. An NER detector may come later behind the same interface (ADR-0015).
- The provider still learns the **type** of data present ("there is a CPF here"), not its value.
- Personal data the model produces on its own (not present in the request) is not touched.
- There is no per-key deny-list or detector selection, and no team-level mode.
