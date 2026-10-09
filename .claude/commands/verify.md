---
description: Verify a spec is fully done (SDD step 5)
argument-hint: <NNN>
---
For `docs/specs/$1-*/`:

1. Check that every task in tasks.md is ticked.
2. For each AC in spec.md, point to the test(s) that prove it. List any AC without a test as a gap.
3. Run `pnpm verify`, `pnpm test:int` and `pnpm test:contract`.
4. Confirm the README roadmap/features, docs and related ADR statuses are updated.
5. Output a short PR description: summary, AC → test table, screenshots/metrics if relevant.
