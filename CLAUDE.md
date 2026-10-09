# CLAUDE.md: Switchyard development harness

Switchyard is a self-hosted, OpenAI-compatible LLM gateway (Node.js 24 + TypeScript + Fastify, Postgres/pgvector, Redis, Redpanda/Kafka, OpenTelemetry). Read `README.md`, `docs/architecture.md`, `docs/specs/README.md` (backlog) and `docs/adr/README.md` for context.

## Golden rules
1. **Spec-driven.** Never implement a feature without a spec in `docs/specs/NNN-name/spec.md` with `Status: Approved`. If none exists, draft it with `/spec` from the scope in `docs/specs/README.md` and stop for approval.
2. **The human gate is the spec.** Specs need explicit human approval. Once a spec is approved, design, tasks and implementation may run autonomously (`/ship`), unless a blocking ADR is needed.
3. **Test first.** For every task, write or adjust the failing test that proves the linked acceptance criterion, then the code.
4. **Decisions become ADRs.** For a non-trivial choice not covered by an existing ADR (library, data model, protocol, trade-off), write an ADR with status Proposed. If the choice blocks progress and has real trade-offs, stop and ask; if it is reversible and low-risk, pick the recommended option, note it in the ADR and continue.
5. **Stay in scope.** Don't refactor or add features outside the current task. Put ideas in the spec's "Open questions" or the backlog.
6. **Verify before done.** A task is done only when `pnpm verify` passes; then tick it in `tasks.md` and commit.
7. **Keep the backlog current.** Update the status column in `docs/specs/README.md` when a spec changes state.
8. **English only** in code, comments, docs and commits. `PLANO_DO_PROJETO.md` and `IDEIAS_DE_PROJETOS.md` are the owner's local pt-BR notes (git-ignored): read them for context, never commit them.

## Commands
- `pnpm dev`: gateway in watch mode · `pnpm dev:worker`: usage worker
- `pnpm verify`: lint + typecheck + unit tests + build (must pass)
- `pnpm test:int`: integration tests (Testcontainers; needs Docker)
- `pnpm test:contract`: OpenAI SDK contract tests
- `docker compose up -d`: local stack (`--profile ollama` adds an Ollama container)

## SDD slash commands
`/spec` → `/design` → `/tasks` → `/implement` (one task) → `/verify`. `/ship <NNN>` runs design → tasks → all tasks → verify for an approved spec. `/adr` proposes a decision.

## Environment notes
- Primary dev machine is **Windows 10** (Docker Desktop on WSL2, 16 GB RAM, GTX 1060 6 GB); CI runs on Ubuntu. Keep scripts cross-platform: use Node scripts or `pnpm` scripts, not bash-only or PowerShell-only commands.
- Line endings are LF (`.gitattributes`). Use named Docker volumes, not bind mounts, for databases.
- Ollama runs natively on the host; from containers it is `http://host.docker.internal:11434`.
- Redpanda runs with `--smp 1 --memory 1G --overprovisioned`. Keep the default stack under ~4 GB RAM at idle.

## Architecture rules
- `src/core` holds canonical types, errors and ports (interfaces). It must not import from `src/infra` or `src/modules`.
- `src/modules/*` implement features and depend on ports, not on concrete infra.
- `src/infra/*` implements ports (db, redis, kafka, telemetry).
- Build the Fastify app in `src/app.ts` with injectable dependencies so tests can use fakes.
- Public errors use the OpenAI error shape: `{ error: { message, type, code } }`.
- Never log prompt/response content or secrets. Span attributes must be sanitized (ADR-0010).
- Never retry upstream after the first streamed byte has been sent to the client (ADR-0008).
- Never invent benchmark numbers or provider prices. Prices come from `config/pricing.yaml`; unknown prices stay `TODO`.

## Code style
- TypeScript strict, no `any` (use `unknown` + Zod parsing at boundaries).
- Small pure functions for logic (routing, pricing, PII detection) so they're easy to unit-test.
- Biome for lint/format. Conventional Commits with spec id: `feat(cache): add semantic lookup [spec-009]`.

## SDD artifacts
- `docs/specs/README.md`: backlog with scope, dependencies, release and status of every spec.
- `docs/specs/NNN-name/spec.md`: problem, user stories, EARS acceptance criteria (`AC-n`), non-goals, open questions, status.
- `docs/specs/NNN-name/design.md`: components, contracts, data, sequence diagram, related ADRs, risks.
- `docs/specs/NNN-name/tasks.md`: small tasks (≤ ~2h), each linked to ACs and naming its test.
- `docs/adr/NNNN-title.md`: MADR format (see `0000-template.md`), indexed in `docs/adr/README.md`.

## Definition of done (per spec)
All ACs covered by tests · `pnpm verify` and CI green · README/docs updated · backlog status updated · related ADRs Accepted · metrics/spans added for new behaviour.
