# Tasks 015: PII restore in streaming responses

- **Status:** In progress
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-015]`. Lint, typecheck and the task's tests before each commit; full `pnpm verify` at the end.

- [x] **T1. `pii.streamRestore` config**
  - ACs: AC-4 (limits)
  - Do: `src/config/schema.ts`, example config.
  - Test: `test/unit/config/schema.test.ts` › `pii.streamRestore` defaults (`maxHoldMs` 250, no `maxHoldChars`), non-positive values rejected.

- [ ] **T2. Text restorer (pure state machine)**
  - ACs: AC-2, AC-3, AC-4 (limits)
  - Do: `src/modules/pii/stream-restore.ts` › `indexPlaceholders`, `createTextRestorer`.
  - Test: `test/unit/pii/stream-restore.test.ts` › every two-chunk split position (table), one char per chunk, three chunks, no partial placeholder emitted; unknown/altered/lone `<` forwarded at the ruling-out character; text without `<` returned as is; JSON escaping; char limit; ms limit via `push` and `expire`; flush; hold events (`restored`, `ruled_out`, `hold_limit`, `end`) with held time.

- [ ] **T3. Chunk restorer**
  - ACs: AC-1, AC-6
  - Do: `createChunkRestorer` in `stream-restore.ts`.
  - Test: `stream-restore.test.ts` › content and tool-call arguments restored per choice and tool index; synthesised chunks copy `id`/`object`/`created`/`model` and keep indexes; held text released before the finish chunk (or in its own field); usage chunk flushes first; malformed chunks pass through.

- [ ] **T4. Pacing with hold deadlines**
  - ACs: AC-4 (stalled upstream), AC-6
  - Do: `HoldClock`, `restoreSteps` in `stream-restore.ts`.
  - Test: `stream-restore.test.ts` › with a manual clock, a stalled upstream yields the held fragment in a synthesised chunk exactly at `maxHoldMs`; `next()` called once per upstream chunk; final flush at upstream end; upstream errors propagate.

- [ ] **T5. Telemetry**
  - ACs: AC-5
  - Do: `src/modules/pii/telemetry.ts` › `recordStreamHold` (histogram, failure counter, span counts).
  - Test: `test/unit/pii/stream-telemetry.test.ts` › hold seconds recorded for every hold, `switchyard_pii_stream_restore_failures_total{reason="hold_limit"}` only for limit releases, span attributes, no text in points.

- [ ] **T6. Wire into the stage and `streamChat`**
  - ACs: AC-1, AC-6, AC-7
  - Do: `StreamRestore` handle in `stage.ts` (header `masked`, `open(first)`), `restore` arg and step loop in `stream.ts`, flush before the SSE error event, `routes.ts` passes `masked.stream`.
  - Test: `test/unit/proxy/pii-routes.test.ts` › streamed placeholder split across chunks restored + `masked`; finish → usage → `[DONE]` order and usage from upstream text; tool-call arguments restored; mid-stream failure releases held text before the error event, provider called once, TTFB header present.

- [ ] **T7. `/v1/messages` streams**
  - ACs: AC-1 (spec 014 part, non-goal boundary)
  - Do: `messages.ts` passes `masked.stream`; native first chunk → `masked-unrestored`.
  - Test: `test/unit/proxy/messages-usage.test.ts` › cross-family stream restored in `text_delta` + `masked`; same-family native stream stays `masked-unrestored`.

- [ ] **T8. Privacy proof for streams**
  - ACs: AC-8
  - Test: `test/unit/pii/stream-privacy.test.ts` › a streamed `mask` request whose answer splits placeholders: trace-level logs, spans and metric points contain no original value; the response body does.

- [ ] **T9. Docs and verification**
  - Do: README PII section, `docs/pii.md`, example config comment, verification table here, spec status.
