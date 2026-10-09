# 0001. Record architecture decisions and develop spec-first

- **Status:** Accepted
- **Date:** 2026-10-09
- **Related specs:** all

## Context
Switchyard is built incrementally, largely with an AI coding assistant (Claude Code). Without durable written context, decisions get lost between sessions, the assistant may make silent choices, and reviewers can't tell *why* the system looks the way it does.

## Options considered
1. **No formal process**: fast to start, but context lives only in chat history.
2. **ADRs only**: captures decisions, not feature intent or acceptance criteria.
3. **ADRs + spec-driven development (spec → design → tasks)**: more upfront writing, but every feature has testable acceptance criteria and every decision has a rationale.

## Decision
We will use **MADR-style ADRs** in `docs/adr/` and **spec-driven development** in `docs/specs/`, with acceptance criteria written in **EARS** syntax. Implementation happens one task at a time, test-first, as described in `CLAUDE.md`.

## Consequences
- ✅ Reviewers and contributors can trace code → task → acceptance criterion → spec → ADR.
- ✅ The AI assistant works from repository files, not conversation memory.
- ⚠️ Extra writing per feature; keep specs short and focused.
- 🔁 Revisit if the overhead clearly outweighs the benefit for small changes (e.g. allow "chore" changes without specs).
