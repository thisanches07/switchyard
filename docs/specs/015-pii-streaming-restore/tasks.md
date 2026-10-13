# Tasks 015: PII restore in streaming responses

- **Status:** Done (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-015]`. Lint, typecheck and the task's tests before each commit; full `pnpm verify` at the end.

- [x] **T1. `pii.streamRestore` config**
  - ACs: AC-4 (limits)
  - Do: `src/config/schema.ts`, example config.
  - Test: `test/unit/config/schema.test.ts` › `pii.streamRestore` defaults (`maxHoldMs` 250, no `maxHoldChars`), non-positive values rejected.

- [x] **T2. Text restorer (pure state machine)**
  - ACs: AC-2, AC-3, AC-4 (limits)
  - Do: `src/modules/pii/stream-restore.ts` › `indexPlaceholders`, `createTextRestorer`.
  - Test: `test/unit/pii/stream-restore.test.ts` › every two-chunk split position (table), one char per chunk, three chunks, no partial placeholder emitted; unknown/altered/lone `<` forwarded at the ruling-out character; text without `<` returned as is; JSON escaping; char limit; ms limit via `push` and `expire`; flush; hold events (`restored`, `ruled_out`, `hold_limit`, `end`) with held time.

- [x] **T3. Chunk restorer**
  - ACs: AC-1, AC-6
  - Do: `createChunkRestorer` in `stream-restore.ts`.
  - Test: `stream-restore.test.ts` › content and tool-call arguments restored per choice and tool index; synthesised chunks copy `id`/`object`/`created`/`model` and keep indexes; held text released before the finish chunk (or in its own field); usage chunk flushes first; malformed chunks pass through.

- [x] **T4. Pacing with hold deadlines**
  - ACs: AC-4 (stalled upstream), AC-6
  - Do: `HoldClock`, `restoreSteps` in `stream-restore.ts`.
  - Test: `stream-restore.test.ts` › with a manual clock, a stalled upstream yields the held fragment in a synthesised chunk exactly at `maxHoldMs`; `next()` called once per upstream chunk; final flush at upstream end; upstream errors propagate.

- [x] **T5. Telemetry**
  - ACs: AC-5
  - Do: `src/modules/pii/telemetry.ts` › `recordStreamHold` (histogram, failure counter, span counts).
  - Test: `test/unit/pii/stream-telemetry.test.ts` › hold seconds recorded for every hold, `switchyard_pii_stream_restore_failures_total{reason="hold_limit"}` only for limit releases, span attributes, no text in points.

- [x] **T6. Wire into the stage and `streamChat`**
  - ACs: AC-1, AC-6, AC-7
  - Do: `StreamRestore` handle in `stage.ts` (header `masked`, `open(first)`), `restore` arg and step loop in `stream.ts`, flush before the SSE error event, `routes.ts` passes `masked.stream`.
  - Test: `test/unit/proxy/pii-stream-routes.test.ts` (and the updated stream case in `pii-routes.test.ts`) › streamed placeholder split across chunks restored + `masked`; finish → usage → `[DONE]` order and usage from upstream text; tool-call arguments restored; mid-stream failure releases held text before the error event, provider called once, TTFB header present.

- [x] **T7. `/v1/messages` streams**
  - ACs: AC-1 (spec 014 part, non-goal boundary)
  - Do: `messages.ts` passes `masked.stream`; native first chunk → `masked-unrestored`. (Committed with T6: the stage sends `masked` for every masked stream, so the route had to restore in the same commit.)
  - Test: `test/unit/proxy/messages-usage.test.ts` › cross-family stream restored in `text_delta` + `masked`; same-family native stream stays `masked-unrestored`.

- [x] **T8. Privacy proof for streams**
  - ACs: AC-8
  - Test: `test/unit/pii/stream-privacy.test.ts` › a streamed `mask` request whose answer splits placeholders: trace-level logs, spans and metric points contain no original value; the response body does.

- [x] **T9. Docs and verification**
  - Do: README PII section, `docs/pii.md`, threat model, example config comment, OpenAI SDK contract test for a masked stream, verification table here, spec status.

## Verification (2026-10-13)

| AC | Proven by | Result |
|---|---|---|
| AC-1 | `stream-restore.test.ts` › content and arguments per choice and tool index, JSON escaping; `pii-stream-routes.test.ts` › one char per chunk restored in content and arguments + `masked`; `pii-routes.test.ts` › echo stream restored; `messages-usage.test.ts` › cross-family `/v1/messages` stream restored; `openai-sdk.contract.test.ts` › SDK stream gets the CPF back | ✅ |
| AC-2 | `stream-restore.test.ts` › every split from `<\|CPF_1>` to `<CPF_1\|>` (table), one char per chunk, three or more chunks, no piece ends with a partial placeholder; `pii-stream-routes.test.ts` › no SSE event carries a placeholder piece | ✅ |
| AC-3 | `stream-restore.test.ts` › `<CPF_9>`, `<cpf_1>`, `< CPF_1 >`, `<CPF-1>`, lone `<` forwarded unchanged and released at the ruling-out character | ✅ |
| AC-4 | `stream-restore.test.ts` › text without `<` keeps its boundaries; `maxHoldChars`; `maxHoldMs` via `push` and `expire`, deadline not extended by a growing fragment; `restoreSteps` › stalled upstream: fragment observed at exactly `maxHoldMs` (manual clock), one `next()` per upstream chunk | ✅ |
| AC-5 | `stream-telemetry.test.ts` › `switchyard_pii_stream_hold_seconds` for every hold, `switchyard_pii_stream_restore_failures_total{reason="hold_limit"}` only for limit releases, span counts; `stream-privacy.test.ts` › no text in points | ✅ |
| AC-6 | `stream-restore.test.ts` › synthesised chunk before the finish chunk (or in the finish chunk's own field), usage chunk flushes first, final flush; `pii-stream-routes.test.ts` › finish → usage → `[DONE]`, usage estimated from the upstream (masked) text | ✅ |
| AC-7 | `pii-stream-routes.test.ts` › mid-stream failure: `<CP` released in the chunk just before the error event, no `[DONE]`, provider called once, `x-switchyard-ttfb-ms` set; `stream-restore.test.ts` › upstream errors propagate | ✅ |
| AC-8 | `stream-privacy.test.ts` › `trace`-level logs, all spans and the PII metric points of streamed `mask` requests (split placeholders, every type) contain no original value, while the bodies contain all of them | ✅ |
| Non-goal (`/v1/messages`) | `messages-usage.test.ts` › same-family native stream keeps `<EMAIL_1>` and says `masked-unrestored` | ✅ |

Notes:
- `pnpm verify` green (1204 unit tests); `openai-sdk.contract.test.ts` green (20). No integration test or infrastructure was touched, so `pnpm test:int` was not re-run.
- Hold counts are set on the serving attempt's upstream span (spec 008's `annotate`), not the request span: `@fastify/otel` ends the request span in `onSend`, before a stream body flows.
- T6 and T7 were committed together (see T7).
