---
description: Break an approved design into small tasks (SDD step 3)
argument-hint: <NNN>
---
Create `tasks.md` next to `docs/specs/$1-*/design.md`.

- Each task: checkbox, short imperative title, linked ACs, the test that proves it (file + test name), and files likely touched.
- Tasks must be small (≈ ≤ 2h), ordered so the build stays green after each one.
- Include final tasks for docs/README updates and observability.
- Stop and ask for approval.
