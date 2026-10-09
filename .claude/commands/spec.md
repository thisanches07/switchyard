---
description: Draft a new feature spec (SDD step 1)
argument-hint: <NNN> <feature-name> [short description]
---
Create `docs/specs/$1-$2/spec.md` for: $ARGUMENTS

1. Read `CLAUDE.md`, `README.md`, `docs/architecture.md`, existing ADRs and specs. Start from the scope, dependencies and release listed for this spec in `docs/specs/README.md`; set its status there to `draft`.
2. Use the structure of `docs/specs/001-bootstrap/spec.md`: Status (Draft), Related ADRs, Problem, User stories, Acceptance criteria in **EARS** with ids `AC-n`, Non-goals, Open questions.
3. Every AC must be observable and testable. Prefer 5–10 ACs.
4. Do NOT write design or code. Stop and ask me to review and approve.
