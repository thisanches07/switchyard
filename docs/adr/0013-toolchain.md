# 0013. Toolchain: pnpm, ESM, tsc build, tsx for dev, Vitest, Biome, Testcontainers

- **Status:** Accepted
- **Date:** 2026-10-09
- **Related specs:** 001

## Context
Every later spec inherits the toolchain, and an AI assistant will run its commands hundreds of times. It must be fast, work the same on Windows and Linux CI, and produce boring, standard output.

## Options considered
1. **pnpm · ESM · `tsc` build · `tsx watch` for dev · Vitest · Biome · Testcontainers**: fast installs and tests, native ESM matching the OTel `--import` hook, one tool for lint + format, real dependencies in integration tests.
2. **npm · CommonJS · `tsup` · Jest · ESLint + Prettier**: very familiar, but slower, ESM friction with Jest, and two lint/format tools to configure.
3. **Node 24 native type stripping, no build step**: fewest tools, but forbids enums/parameter properties, needs `.ts` import extensions, and the Docker image would ship sources; `tsc` is still needed for typechecking.

## Decision
Use option 1:
- **pnpm** pinned via `packageManager` and Corepack.
- **ESM** (`"type": "module"`), `tsconfig` `module`/`moduleResolution` = `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **`tsc`** emits `dist/`; **`tsx watch`** for `pnpm dev`.
- **Vitest** for unit (`test/unit`), integration (`test/integration`, Testcontainers) and, from spec 002, contract tests, each as a separate project/script. Coverage with `@vitest/coverage-v8`.
- **Biome** for lint and format (`biome ci` in `pnpm verify`).

## Consequences
- ✅ One fast `pnpm verify` gate, identical locally and in CI.
- ✅ ESM-first matches the OpenTelemetry `--import` preload model.
- ⚠️ Biome has fewer rules than the ESLint ecosystem; acceptable for this codebase.
- ⚠️ Testcontainers needs Docker running for `pnpm test:int` (Docker Desktop locally).
- 🔁 Revisit if build times or ESM interop become a real cost.
