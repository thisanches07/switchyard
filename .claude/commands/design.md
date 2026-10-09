---
description: Write the technical design for an approved spec (SDD step 2)
argument-hint: <NNN>
---
Write `design.md` next to the spec `docs/specs/$1-*/spec.md`.

1. Refuse if the spec status is not `Approved`; tell me why.
2. Include: components/modules touched (respecting the architecture rules in CLAUDE.md), public contracts (HTTP, events, config), data model/migrations, a Mermaid sequence diagram of the main flow, failure modes, metrics/spans to add, risks, and a mapping AC → component.
3. For each non-trivial choice, list options and, if it deserves an ADR, draft it with status Proposed in `docs/adr/` using `0000-template.md` and link it.
4. Stop and ask for approval. No code.
