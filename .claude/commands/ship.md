---
description: Take an approved spec all the way to done (design → tasks → implement all → verify)
argument-hint: <NNN>
---
Ship spec `docs/specs/$1-*/` end to end.

1. Refuse if `spec.md` is not `Status: Approved`; tell me what to review.
2. Create a branch `feat/$1-<name>` if not already on it.
3. If `design.md` is missing, write it following `/design` rules. Draft any needed ADRs as Proposed. Stop only if an ADR blocks progress with real trade-offs (CLAUDE.md rule 4).
4. If `tasks.md` is missing, write it following `/tasks` rules.
5. Implement every unchecked task in order, following `/implement` rules for each one: test first, `pnpm verify` green, tick the box, one commit per task ending in `[spec-$1]`.
6. If the same task fails verification 3 times in a row, stop and report the failure with the exact error output instead of working around it.
7. Run the `/verify` steps. Mark the spec `Status: Done` and update `docs/specs/README.md`.
8. Report: commits made, AC → test table, ADRs created, anything left open, and the suggested PR description.
