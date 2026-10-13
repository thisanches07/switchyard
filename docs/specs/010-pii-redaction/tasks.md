# Tasks 010: PII redaction (mask and block)

- **Status:** Approved (2026-10-13)
- **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

One commit per task, ending in `[spec-010]`. `pnpm verify` green after each (exit code checked, not grepped).

- [ ] **T1. Core PII types and the `pii` config key**
  - ACs: AC-1
  - Do: `src/core/pii.ts`; `pii` in `src/config/schema.ts`; example config.
  - Test: `test/unit/config/schema.test.ts` › `pii` defaults (`off`, all detectors, empty deny-list), unknown mode/detector and empty term rejected.

- [ ] **T2. `pii_mode` in the data model**
  - ACs: AC-1, AC-2
  - Do: enum + column, migration via `pnpm db:generate --name pii_mode`; `ApiKeyRecord`/`NewKey`/`Principal`/`KeyPatch`; Drizzle and memory stores; principal carries the key's mode.
  - Test: `db.int.test.ts` › column nullable, stored on create, updated and cleared; `memory-store.test.ts` › same semantics; `authenticate.test.ts` › principal `piiMode`.

- [ ] **T3. Admin API: `piiMode`**
  - ACs: AC-2
  - Do: create and PATCH accept `piiMode` (PATCH may set it alone), key views return it, cache invalidated, OpenAPI bodies.
  - Test: `test/unit/admin/admin.test.ts` › create with/without `piiMode`, PATCH set/`null`, invalid value 400, listing, cache invalidation.

- [ ] **T4. Validators**
  - ACs: AC-3, AC-4
  - Test: `test/unit/pii/validators.test.ts` › Luhn, CPF and CNPJ check digits (numeric and alphanumeric, valid and invalid), repeated digits, DDD list, e-mail domains, IPv4/IPv6.

- [ ] **T5. Detectors and overlap resolution**
  - ACs: AC-3, AC-4, AC-5
  - Test: `test/unit/pii/scan.test.ts` › every AC-3 vector found with the right type, every AC-4 vector not reported, disabled detectors do not run, deny-list case and word boundaries, longest match and validator tie-break, characters replaced once.

- [ ] **T6. Linear-time guarantees**
  - ACs: AC-6
  - Test: `test/unit/pii/linear.test.ts` › no unbounded quantifier in any detector pattern; 1 MiB adversarial inputs (digits, `a@`, `1.`, `:`, `1 `, letters) each scanned in < 500 ms.

- [ ] **T7. Masking and restore (pure)**
  - ACs: AC-7, AC-8
  - Test: `test/unit/pii/mask.test.ts` › placeholders numbered per type, same string same placeholder across messages, reserved client placeholders skipped, all roles, text parts only, tool-call arguments (JSON and raw), embeddings string/array/token arrays, input not mutated; `test/unit/pii/restore.test.ts` › content and arguments of every choice, JSON escaping, unknown/altered placeholders untouched, malformed bodies returned as-is.

- [ ] **T8. PII stage in the chat and embeddings routes**
  - ACs: AC-7, AC-8, AC-9, AC-10, AC-11
  - Do: `src/modules/pii/stage.ts`, `piiDetected` error, route wiring after admission, `request.pii`.
  - Test: `test/unit/proxy/pii-routes.test.ts` › provider receives placeholders; restored body + `masked`; stream keeps placeholders + `masked-unrestored`; embeddings masked; `none` when clean; no header and no scan when `off`; key mode overrides default; block 400 for chat, stream and embeddings with types only, provider not called, tokens refunded and request unit kept.

- [ ] **T9. Telemetry and the privacy proof**
  - ACs: AC-12, AC-13 (metric and span)
  - Test: `test/unit/pii/telemetry.test.ts` › `switchyard_pii_detections_total{type}` counts occurrences, span attributes for mask/block/none, `uninspected`; `test/unit/pii/privacy.test.ts` › trace-level logs, spans and metric points of mask and block requests with every AC-3 vector contain none of them.

- [ ] **T10. Mock `echo` model, contract test and smoke steps**
  - ACs: AC-14 (and AC-8 end to end)
  - Test: `test/unit/providers/mock.test.ts` › `echo` answers and streams the last user text; `openai-sdk.contract.test.ts` › `block` key → `BadRequestError` `pii_detected`; `scripts/compose-smoke.ts` › block 400, mask 200 + `masked` + restored CPF.

- [ ] **T11. Docs**
  - ACs: AC-9 (docs part)
  - Do: README PII section (modes, headers, streaming limitation → spec 015, what is not detected), `docs/pii.md` guide, threat-model row, architecture note, verification table here.

- [ ] **T12. Usage events: `piiDetections` and `rejected` outcome** — *blocked until spec 006 merges*
  - ACs: AC-13 (usage event part)
  - Do: in 006's outcome hook, set `piiDetections` from `request.pii?.detections ?? {}`; record blocked requests (thrown by the PII stage) as `outcome: "rejected"`, `status: 400`, `errorCode: "pii_detected"`, `provider: null`, `attempts: 0`.
  - Test: 006's hook tests › mask request event carries counts, off/clean carry `{}`, blocked chat/stream/embeddings produce exactly one `rejected` event.
