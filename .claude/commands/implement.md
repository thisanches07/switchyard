---
description: Implement the next unchecked task of a spec, test-first (SDD step 4)
argument-hint: <NNN>
---
Work on `docs/specs/$1-*/tasks.md`.

1. Pick the FIRST unchecked task only. Re-read its ACs in spec.md and the relevant part of design.md.
2. Write/adjust the failing test first and run it to confirm it fails for the right reason.
3. Implement the minimal code to make it pass, following CLAUDE.md architecture and style rules.
4. Run `pnpm verify` (and `pnpm test:int` if infra is involved). Fix until green.
5. Tick the checkbox, then commit with a Conventional Commit message ending in `[spec-$1]`.
6. If you hit an unplanned decision, stop and propose an ADR instead of guessing.
7. Report: what changed, tests added, anything left open. Do not start the next task.
