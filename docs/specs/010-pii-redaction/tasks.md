# Tasks 010: PII redaction (mask and block)

- **Status:** Approved (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-010]`. `pnpm verify` green after each (exit code checked, not grepped).

- [x] **T1. Core PII types and the `pii` config key**
  - ACs: AC-1
  - Do: `src/core/pii.ts`; `pii` in `src/config/schema.ts`; example config.
  - Test: `test/unit/config/schema.test.ts` › `pii` defaults (`off`, all detectors, empty deny-list), unknown mode/detector and empty term rejected.

- [x] **T2. `pii_mode` in the data model**
  - ACs: AC-1, AC-2
  - Do: enum + column, migration via `pnpm db:generate --name pii_mode`; `ApiKeyRecord`/`NewKey`/`Principal`/`KeyPatch`; Drizzle and memory stores; principal carries the key's mode.
  - Test: `db.int.test.ts` › column nullable, stored on create, updated and cleared; `memory-store.test.ts` › same semantics; `authenticate.test.ts` › principal `piiMode`.

- [x] **T3. Admin API: `piiMode`**
  - ACs: AC-2
  - Do: create and PATCH accept `piiMode` (PATCH may set it alone), key views return it, cache invalidated, OpenAPI bodies.
  - Test: `test/unit/admin/admin.test.ts` › create with/without `piiMode`, PATCH set/`null`, invalid value 400, listing, cache invalidation.

- [x] **T4. Validators**
  - ACs: AC-3, AC-4
  - Test: `test/unit/pii/validators.test.ts` › Luhn, CPF and CNPJ check digits (numeric and alphanumeric, valid and invalid), repeated digits, DDD list, e-mail domains, IPv4/IPv6.

- [x] **T5. Detectors and overlap resolution**
  - ACs: AC-3, AC-4, AC-5
  - Test: `test/unit/pii/scan.test.ts` › every AC-3 vector found with the right type, every AC-4 vector not reported, disabled detectors do not run, deny-list case and word boundaries, longest match and validator tie-break, characters replaced once.

- [x] **T6. Linear-time guarantees**
  - ACs: AC-6
  - Test: `test/unit/pii/linear.test.ts` › no unbounded quantifier in any detector pattern; 1 MiB adversarial inputs (digits, `a@`, `1.`, `:`, `1 `, letters) each scanned in < 500 ms.

- [x] **T7. Masking and restore (pure)**
  - ACs: AC-7, AC-8
  - Test: `test/unit/pii/mask.test.ts` › placeholders numbered per type, same string same placeholder across messages, reserved client placeholders skipped, all roles, text parts only, tool-call arguments (JSON and raw), embeddings string/array/token arrays, input not mutated; `test/unit/pii/restore.test.ts` › content and arguments of every choice, JSON escaping, unknown/altered placeholders untouched, malformed bodies returned as-is.

- [x] **T8. PII stage in the chat and embeddings routes**
  - ACs: AC-7, AC-8, AC-9, AC-10, AC-11
  - Do: `src/modules/pii/stage.ts`, `piiDetected` error, route wiring after admission, `request.pii`.
  - Test: `test/unit/proxy/pii-routes.test.ts` › provider receives placeholders; restored body + `masked`; stream keeps placeholders + `masked-unrestored`; embeddings masked; `none` when clean; no header and no scan when `off`; key mode overrides default; block 400 for chat, stream and embeddings with types only, provider not called, tokens refunded and request unit kept.

- [x] **T9. Telemetry and the privacy proof**
  - ACs: AC-12, AC-13 (metric and span)
  - Test: `test/unit/pii/telemetry.test.ts` › `switchyard_pii_detections_total{type}` counts occurrences, span attributes for mask/block/none, `uninspected`; `test/unit/pii/privacy.test.ts` › trace-level logs, spans and metric points of mask and block requests with every AC-3 vector contain none of them.

- [x] **T10. Mock `echo` model, contract test and smoke steps**
  - ACs: AC-14 (and AC-8 end to end)
  - Test: `test/unit/providers/mock.test.ts` › `echo` answers and streams the last user text; `openai-sdk.contract.test.ts` › `block` key → `BadRequestError` `pii_detected`; `scripts/compose-smoke.ts` › block 400, mask 200 + `masked` + restored CPF.

- [x] **T11. Docs**
  - ACs: AC-9 (docs part)
  - Do: README PII section (modes, headers, streaming limitation → spec 015, what is not detected), `docs/pii.md` guide, threat-model row, architecture note, verification table here.

- [ ] **T12. Usage events: `piiDetections` and `rejected` outcome** — *blocked until spec 006 merges*
  - ACs: AC-13 (usage event part)
  - Do: in 006's outcome hook, set `piiDetections` from `request.pii?.detections ?? {}`; record blocked requests (thrown by the PII stage) as `outcome: "rejected"`, `status: 400`, `errorCode: "pii_detected"`, `provider: null`, `attempts: 0`.
  - Test: 006's hook tests › mask request event carries counts, off/clean carry `{}`, blocked chat/stream/embeddings produce exactly one `rejected` event.

## Verification (2026-10-13, all tasks but T12)

| AC | Proven by | Result |
|---|---|---|
| AC-1 | `schema.test.ts` › `pii` defaults, mode/detector/term validation, example config; `db.int.test.ts` › `pii_mode` enum column, nullable | ✅ |
| AC-2 | `pii-routes.test.ts` › admin PATCH to `block` applies to the next request; `admin.test.ts` › `piiMode` on create, list, PATCH alone (limits kept), `null` clears, invalid values 400, cached key dropped; `authenticate.test.ts` › principal carries the key's mode; `db.int.test.ts` › stored, updated, cleared, enum enforced | ✅ |
| AC-3 | `scan.test.ts` › every vector found with its type, alone and inside sentences; `validators.test.ts` | ✅ |
| AC-4 | `scan.test.ts` › every false-positive vector (and a few more) not reported | ✅ |
| AC-5 | `scan.test.ts` › CPF vs phone, CPF-shaped phone tie-break, CNPJ vs card, longest match, no double replacement | ✅ |
| AC-6 | `linear.test.ts` › bounded quantifiers in every pattern; 1 MiB adversarial inputs < 500 ms CPU each; linear growth on dense real values | ✅ (see note) |
| AC-7 | `mask.test.ts` › numbering, same string same placeholder, every role, text parts only, tool-call arguments, reserved placeholders, input not mutated; `pii-routes.test.ts` › provider receives `<CPF_1>` | ✅ |
| AC-8 | `restore.test.ts`; `pii-routes.test.ts` › restored content and arguments, `masked`; contract › SDK gets the value back through `mock/echo`; smoke › mask step | ✅ |
| AC-9 | `pii-routes.test.ts` › stream keeps `<CPF_1>`, `masked-unrestored`; README and `docs/pii.md` state the limitation and link spec 015 | ✅ |
| AC-10 | `pii-routes.test.ts` › `none` when clean; header absent and original forwarded when `off`; key mode overrides the default | ✅ |
| AC-11 | `pii-routes.test.ts` › 400 `pii_detected` `(cpf, email)` for chat, stream and embeddings, provider not called, tokens refunded, request unit kept; contract › `BadRequestError`; smoke › block step | ✅ |
| AC-12 | `privacy.test.ts` › `trace`-level logs, all spans (attributes, events, status) and metric points of mask and block requests carrying every vector contain none of them | ✅ |
| AC-13 | `telemetry.test.ts` › `switchyard_pii_detections_total{type}` occurrences, request-span `mode`/`action`/`detections`/`uninspected`, nothing when off; `pii-routes.test.ts` › `request.pii` shape. **`UsageEvent.piiDetections` and `rejected` events: T12, blocked until spec 006 merges** | ⏳ partial |
| AC-14 | `openai-sdk.contract.test.ts` › `BadRequestError` with `code: "pii_detected"`; `scripts/compose-smoke.ts` › block 400 and mask 200 + `masked` + restored CPF | ✅ |

Notes:
- AC-6 timing is measured as the scan's **CPU time** (`process.cpuUsage`), equal to wall time on an idle CI runner, so a saturated shared dev machine does not make it flaky. A 1 MiB input made only of real values (~73k detections) is checked for linear growth instead of an absolute budget: its cost is per detection, not adversarial.
- Migration generated as `0002_pii_mode` on this branch (006's `0002_usage_events` is not merged yet); it becomes `0003_pii_mode` when rebased onto 006 (`pnpm db:generate` on top of `main`, see `waves.md`).
- Local smoke runs: every functional step passed, including both PII steps; `compose up --wait` itself reported the gateway unhealthy once while the shared host was at 100% CPU (it then served `/healthz` 200 and passed all steps).
