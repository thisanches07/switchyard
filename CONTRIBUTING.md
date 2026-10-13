# Contributing to Switchyard

Thanks for your interest! Switchyard is built spec-first, so a short read of how work flows will save you time.

## Ground rules
- **Small fixes** (typos, docs, obvious bugs with a test): open a pull request directly.
- **Features or behaviour changes**: open an issue first. If it is accepted, it gets a spec in [`docs/specs/`](docs/specs/README.md) with acceptance criteria before any code is written.
- **Technical decisions** with real trade-offs are recorded as [ADRs](docs/adr/README.md).
- Everything in the repository is written in English.

## Setup
```bash
corepack enable
pnpm install
pnpm verify          # lint, typecheck, unit tests with coverage, build
pnpm test:int        # needs Docker
pnpm test:contract
```

## Pull requests
- One logical change per PR, with tests that prove it (test first).
- `pnpm verify` must pass; CI also runs integration, contract and Compose smoke tests.
- Conventional Commits, with the spec id when there is one: `feat(proxy): add streaming [spec-003]`.
- Never log or trace prompt/response content or secrets ([ADR-0010](docs/adr/0010-no-prompt-persistence.md)).

## Reporting security issues
Please do not open public issues for vulnerabilities. Use GitHub's private vulnerability reporting on this repository instead.
