# Spec 015: PII restore in streaming responses

- **Status:** Done (2026-10-13)
- **Owner:** @thisanches07
- **Release:** stretch
- **Depends on:** 010
- **Related ADRs:** 0015 (PII detection and reversible placeholders), 0008 (no retry after first byte), 0010 (no prompt persistence)

## Problem
Spec 010 masks personal data in every request and restores the original values in non-streaming answers. Streamed answers keep the placeholders (`<CPF_1>`) and are flagged with `x-switchyard-pii: masked-unrestored`, so an application that streams and uses `mask` shows its users text like "your CPF <CPF_1> is registered".

Restoring in a stream is not a simple string replace on each chunk:
- providers split text at arbitrary points, so a placeholder can arrive as `<CP` in one chunk and `F_1>` in the next, or one character per chunk;
- holding text back to see whether it completes a placeholder adds latency, which is the reason clients stream in the first place;
- a held fragment may never complete (the model wrote a literal `<`, or the stream stalls), so holding must be bounded;
- the gateway must not break the stream contract: chunk shape, per-choice ordering, the `finish_reason` chunk, the `include_usage` chunk and the ADR-0008 error behaviour.

## User stories
- As an **application developer**, I want streamed answers to contain the original values, so `mask` behaves the same with and without `stream: true`.
- As an **operator**, I want the extra latency from restoring to be small and bounded, and measured.
- As an **application developer**, I want text the model invented that only looks like a placeholder to reach me unchanged.

## Concepts
- **Restorer:** a per-choice (and per tool-call) state machine over the streamed text. Text that cannot be the start of a known placeholder is forwarded at once; a fragment that could still become one (`<`, `<C`, `<CPF_`…) is **held** until it completes, is ruled out, or a hold limit is reached.
- **Hold limits:** `pii.streamRestore.maxHoldChars` (default: the length of the longest placeholder in the request's restore map) and `pii.streamRestore.maxHoldMs` (default `250`). When a limit is reached, the held fragment is released **as-is** (unrestored): latency wins over restoring a placeholder that is not arriving.
- **Synthesised chunk:** when held text must be released and no upstream chunk is available to carry it, the gateway emits a chunk with the same `id`, `object`, `created` and `model` as the stream and the same choice `index`.

## Acceptance criteria (EARS)

### Restoring
- **AC-1** WHEN a masked chat request is streaming, THE gateway SHALL replace every known placeholder in `choices[].delta.content` and `choices[].delta.tool_calls[].function.arguments` with its original string (JSON-escaped inside arguments), independently per choice `index` and per tool-call `index`, and SHALL send `x-switchyard-pii: masked` instead of `masked-unrestored`.
- **AC-2** FOR a stream whose text contains a placeholder, THE concatenated client-side text SHALL equal the restored text for **every** split of the placeholder across two chunks (each position from `<|CPF_1>` to `<CPF_1|>`), for one character per chunk, and for a placeholder split across three or more chunks; and no chunk sent to the client SHALL contain a partial placeholder while the hold limits are not exceeded. A table-driven unit test SHALL enumerate every split position.
- **AC-3** WHEN streamed text contains a placeholder-shaped string that is not in the restore map (`<CPF_9>`), an altered one (`<cpf_1>`, `< CPF_1 >`) or a lone `<`, THE gateway SHALL forward it unchanged, releasing it as soon as it can no longer become a known placeholder.

### Latency bounds
- **AC-4** THE gateway SHALL forward chunk text that cannot start a known placeholder without holding it, so a stream with no `<` in its text has the same chunk boundaries as without restore; and SHALL never hold more than `maxHoldChars` characters or for longer than `maxHoldMs` per choice, after which it SHALL release the held fragment unrestored (in a synthesised chunk if no upstream chunk arrives). A test with a stalled upstream SHALL observe the fragment within `maxHoldMs` + 50 ms.
- **AC-5** THE gateway SHALL record the time text is held in `switchyard_pii_stream_hold_seconds` (histogram) and count released-unrestored fragments in `switchyard_pii_stream_restore_failures_total{reason="hold_limit"}`, never with the text as a label.

### Stream contract
- **AC-6** WHEN the upstream stream ends, THE gateway SHALL release every held fragment (restored if complete) before the chunk carrying `finish_reason` of that choice, then send the usage chunk (if the client asked for it, spec 003) and `data: [DONE]`. Usage chunks and token estimation SHALL be computed from the upstream text and are unaffected by restore.
- **AC-7** WHEN the upstream fails mid-stream or the client disconnects, THE gateway SHALL behave as in spec 003 and ADR-0008: held text is released (as-is) before the SSE error event, no retry or fallback happens after the first upstream chunk, and holding SHALL NOT delay the moment the stream counts as started (`x-switchyard-ttfb-ms` still measures the first upstream chunk).
- **AC-8** THE restore map SHALL stay in the request's memory only, as in spec 010 AC-12; a log- and span-capture test over a streamed `mask` request SHALL find no original value.

## Non-goals
- Restoring placeholders the model paraphrased or translated (`CPF number 1`, `<CPF-1>`); restore is best-effort exact matching (ADR-0015).
- Restoring in cached responses re-chunked by spec 009 beyond what this mechanism gives for free (they go through the same restorer).
- Changing what spec 010 masks or how placeholders are numbered.
- Restoring in the Anthropic `/v1/messages` stream (spec 014) unless it reuses the same chunk pipeline.

## Open questions
- Is 250 ms the right default for `maxHoldMs`? (Proposed: yes for now; the benchmark of spec 012 measures the TTFT and inter-chunk impact with restore on and off, and the default is revisited with those numbers.)
- Should a held fragment be released early when the next upstream character rules it out, even before the hold limit? (Proposed: yes, that is the normal path; the limits only cover a stalled or very long fragment.)
- Should restore failures (released unrestored) be signalled to the client, e.g. a trailer or final header? (Proposed: no; headers are already sent, so it is only visible in metrics and span attributes.)
