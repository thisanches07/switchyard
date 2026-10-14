# Tasks 013: Deploy

Design: [design.md](design.md). Each task ends with lint, typecheck and its related tests;
the full `pnpm verify` runs once at the end. Docker- and Terraform-heavy checks run in CI.

- [x] **T1. Release preflight (version + changelog)** — AC-1, AC-3
  - Test: `test/unit/scripts/release.test.ts` ("accepts v0.1.0 matching package.json", "rejects a mismatching tag", "extracts the changelog section", "fails without a section", "flags pre-releases").
  - Files: `scripts/lib/release.ts`, `scripts/release-check.ts`, `package.json` (version `0.1.0`), `CHANGELOG.md`.
- [x] **T2. Tracked-secrets check and .gitignore** — AC-10
  - Test: `test/unit/scripts/tracked-secrets.test.ts` ("flags state, .terraform, tfvars and env files", "allows examples and the lock file"), plus the repo's own `git ls-files` passes.
  - Files: `scripts/lib/tracked-secrets.ts`, `scripts/check-tracked-secrets.ts`, `.gitignore`, `.github/workflows/ci.yml`.
- [x] **T3. Gateway refuses dev secrets when required** — AC-4
  - Test: `test/unit/config/secrets.test.ts` ("lists dev-only ADMIN_TOKEN, KEY_PEPPER and the dev DB password", "accepts real values", "flag parsing").
  - Files: `src/config/secrets.ts`, `src/config/env.ts`, `src/server.ts`.
- [x] **T4. Dockerfile targets + dev Compose images** — AC-1, AC-2
  - Test: `test/unit/deploy/dockerfile.test.ts` ("has gateway and worker targets", "build stage runs on BUILDPLATFORM", "gateway is the default target"); CI `images-*` jobs.
  - Files: `Dockerfile`, `docker-compose.yml`, `scripts/compose-smoke.ts`.
- [x] **T5. Production Compose, Caddy and demo config** — AC-4, AC-5
  - Test: `test/unit/deploy/compose.test.ts` ("only caddy publishes 80 and 443", "no build", "versioned GHCR images", "secrets are required", "require-secrets flag on", "demo config loads").
  - Files: `deploy/compose/{compose.yml,Caddyfile,switchyard.env.example,config/*}`.
- [x] **T6. `pnpm demo:key`** — AC-6
  - Test: `test/unit/scripts/demo-key.test.ts` (args parsing, plan: create / reuse+patch / rotate, against a fake admin API).
  - Files: `scripts/lib/demo-key.ts`, `scripts/demo-key.ts`, `package.json`.
- [x] **T7. Production stack smoke test + deploy workflow** — AC-2, AC-4, AC-5, AC-6
  - Test: `scripts/deploy-smoke.ts` (CI job `prod-compose`), `test/deploy/{compose.test.yml,pricing.test.yaml}`.
  - Files: `.github/workflows/deploy.yml`.
- [x] **T8. Release workflow** — AC-1, AC-3
  - Test: review + `workflow_dispatch` dry run; `test/unit/deploy/workflows.test.ts` ("release triggers on v* tags", "preflight runs before images", "push only on tags", "both platforms", "pinned actions").
  - Files: `.github/workflows/release.yml`.
- [x] **T9. Terraform for Oracle Always Free** — AC-7, AC-8
  - Test: `deploy/terraform/tests/deploy.tftest.hcl` (mocked provider); CI `terraform` job; lock file for 5 platforms.
  - Files: `deploy/terraform/*.tf`, `.terraform.lock.hcl`, `terraform.tfvars.example`.
- [x] **T10. cloud-init + renderer** — AC-9
  - Test: `test/unit/deploy/cloud-init.test.ts` ("renders only switchyard_version", "rejects unknown placeholders", "docker, unattended-upgrades, ssh hardening, systemd units"); CI `cloud-init` job (`cloud-init schema`).
  - Files: `deploy/terraform/cloud-init.yaml.tftpl`, `scripts/lib/cloud-init.ts`, `scripts/render-cloud-init.ts`.
- [x] **T11. Runbook, README, CHANGELOG, threat model** — AC-11, AC-12
  - Test: `test/unit/repo/files.test.ts` ("deploy runbook covers every required topic", "README links the runbook", "CHANGELOG follows Keep a Changelog").
  - Files: `docs/deploy.md`, `README.md`, `CHANGELOG.md`, `docs/threat-model.md`, `docs/architecture.md` if needed.
- [x] **T12. Verify and close the spec** — all ACs
  - `pnpm verify` once; spec status; AC → test table.

## Verification (2026-10-13)

Local: `pnpm verify` green (1322 unit tests); Terraform 1.16.5 `fmt -check`, `init -backend=false -lockfile=readonly`, `validate` and `terraform test` (9 runs, mocked provider) pass. Docker-based checks were not run locally (owner rule) and first run in the PR's CI.

| AC | Proof | Where |
|---|---|---|
| AC-1 | `test/unit/scripts/release.test.ts`, `test/unit/deploy/{dockerfile,workflows}.test.ts`; multi-arch build | unit; `deploy.yml` › `images-multiarch`, `release-preflight`; push at the first tag |
| AC-2 | dev stack on prebuilt amd64 images (healthz, readyz, worker started + topics, usage counted) | `deploy.yml` › `images-compose` |
| AC-3 | changelog extraction, failure without a section; release job | unit; `release.yml` at the first tag (dry run via `workflow_dispatch`) |
| AC-4 | `test/unit/deploy/compose.test.ts`, `test/unit/config/secrets.test.ts`, `test/unit/server/boot.test.ts`; missing secrets and dev defaults refused | unit; `deploy.yml` › `prod-compose` |
| AC-5 | HTTPS on 443 via Caddy, 80 → redirect, only 80/443 published, other ports refused | `deploy.yml` › `prod-compose` |
| AC-6 | `test/unit/scripts/demo-key.test.ts`; rpm 429, idempotent rerun, 403 other model, `budget_exceeded` | unit; `deploy.yml` › `prod-compose` |
| AC-7 | `deploy/terraform/tests/deploy.tftest.hcl`, `.terraform.lock.hcl` (5 platforms) | local + `deploy.yml` › `terraform` |
| AC-8 | fmt, init, validate, test; no plan/apply | `deploy.yml` › `terraform`; `workflows.test.ts` |
| AC-9 | `test/unit/deploy/cloud-init.test.ts`; `cloud-init schema` | unit; `deploy.yml` › `cloud-init` |
| AC-10 | `test/unit/scripts/tracked-secrets.test.ts`; `scripts/check-tracked-secrets.ts` | unit; `ci.yml` › `verify` |
| AC-11 | `test/unit/repo/files.test.ts` (runbook topics, untested markers) | unit |
| AC-12 | `test/unit/repo/files.test.ts` (README images and link, CHANGELOG) | unit |
