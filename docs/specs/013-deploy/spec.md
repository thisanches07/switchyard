# Spec 013: Deploy (multi-arch images, release workflow, Terraform for Oracle Always Free)

- **Status:** Approved (2026-10-13)
- **Owner:** @thisanches07
- **Release:** v0.3
- **Depends on:** 012
- **Related ADRs:** 0006 (Redis limits), 0010 (no prompt persistence), 0012 (Oracle Cloud Always Free with Terraform), 0020 (dashboards as code). ADR number 0022 is reserved for the fallback in ADR-0012 and is written only if that fallback is used.

## Problem
Switchyard only runs from a local clone: images are built on the developer's machine, there are no versioned releases, and there is no public demo. ADR-0012 chose Oracle Cloud Always Free (ARM VM) with Terraform and multi-arch images on GHCR, but none of it exists.

Three things are needed:
- **Releases:** a tag should produce versioned, multi-arch (amd64 + arm64) images for the gateway and the usage worker, plus release notes, so anyone (including the ARM demo VM) can pull a known version instead of building.
- **Infrastructure as code:** a Terraform configuration that, given an operator's own Oracle account, creates the network, firewall and VM, and a cloud-init that installs Docker and runs the stack with a production Compose profile behind TLS.
- **A safe public demo:** strict rate limits and a hard budget on the demo key, only free or local models, nothing but HTTPS and operator SSH exposed.

The owner has **no cloud account yet**, so everything this spec accepts must be verifiable locally and in CI without one. Actually provisioning the VM is a documented runbook, not an acceptance criterion.

## User stories
- As a **self-hoster**, I want to pull a versioned image for my architecture (x86 or ARM), so I can run Switchyard without building it.
- As a **maintainer**, I want pushing a `vX.Y.Z` tag to publish images and a GitHub Release with notes, so releases are one step and repeatable.
- As an **operator**, I want a Terraform configuration and a runbook that take me from an Oracle account to a running HTTPS demo, so I can deploy without clicking through a console.
- As an **operator**, I want only HTTPS and my own SSH to be reachable and no secrets in the repo or in Terraform state, so the demo is safe to leave running.
- As a **visitor**, I want to try the public demo with a key that cannot run up costs.

## Acceptance criteria (EARS)

### Images and releases
- **AC-1** WHEN a tag matching `v<major>.<minor>.<patch>` (optionally with a pre-release suffix) is pushed, A release workflow SHALL build the gateway and worker images for `linux/amd64` and `linux/arm64` with Docker Buildx (QEMU for the non-native platform) and push them to GHCR under `ghcr.io/thisanches07/…` with the full version tag and, for non-pre-releases, `<major>.<minor>` and `latest`; the images SHALL carry OCI labels for source, revision and version. IF the tag does not match `package.json#version`, THEN the workflow SHALL fail before pushing anything.
- **AC-2** WHEN a pull request changes the `Dockerfile`, `deploy/` or the release workflow, CI SHALL build the images for both platforms without pushing, and SHALL start the **amd64** gateway and worker images inside the Compose stack (images substituted for the local build) and check that the gateway answers `/healthz` and `/readyz` with `200` and the worker reaches the readiness signal defined by spec 006.
- **AC-3** THE release workflow SHALL create a GitHub Release whose notes are the matching section of `CHANGELOG.md` (Keep a Changelog format); IF that section is missing, THEN the workflow SHALL fail. The first release from this spec SHALL be a `v0.x` tag. SBOM and provenance attestations MAY be attached; their absence SHALL NOT fail the release.

### Production Compose profile
- **AC-4** THE repository SHALL contain a production Compose file under `deploy/compose/` that runs the published images by version (no `build:`), a reverse proxy terminating TLS, and the stack's dependencies; only ports `80` and `443` of the proxy SHALL be published on the host; Postgres, Redis, Redpanda, Grafana/OTLP and the gateway SHALL NOT publish host ports; every secret (`ADMIN_TOKEN`, `KEY_PEPPER`, database password, provider keys) SHALL come from an environment file that is not committed, and the stack SHALL refuse to start with the dev defaults from `docker-compose.yml`.
- **AC-5** WHEN CI starts the production Compose file with locally built images and the proxy in a local-certificate mode (no public domain), THE gateway SHALL answer `/healthz` through the proxy over HTTPS on `443`, plain HTTP on `80` SHALL redirect to HTTPS, and connecting to any other published host port SHALL fail.
- **AC-6** THE repository SHALL provide a cross-platform script (`pnpm demo:key`) that, through the admin API, creates the demo team and key with a **hard** monthly budget (spec 007), strict `rpm`/`tpm` limits (spec 005) and `allowedModels` restricted to the demo alias (spec 004), prints the key once, and is idempotent; a test against the Compose stack (with a test-only pricing file that gives the `mock` model a price, so spend accrues) SHALL show the key is rejected with the budget error after its budget is spent and with `429` above its rate limit.

### Terraform and cloud-init (validated without a cloud account)
- **AC-7** THE repository SHALL contain Terraform under `deploy/terraform/` for Oracle Cloud Always Free, pinning the Terraform version and the OCI provider version, with a committed `.terraform.lock.hcl` containing hashes for Linux, Windows and macOS. It SHALL define: a VCN, an internet gateway and route table, one public subnet, a security list (or NSG) allowing ingress only on TCP `80` and `443` from anywhere and TCP `22` from a required `operator_cidr` variable, an Ampere A1 VM whose shape size defaults stay within the Always Free allowance as documented by Oracle, and outputs for the public IP and the SSH command. `operator_cidr` SHALL reject `0.0.0.0/0` through a variable validation.
- **AC-8** WHEN CI runs on a change under `deploy/`, IT SHALL run `terraform fmt -check -recursive`, `terraform init -backend=false` and `terraform validate` (and `tflint` if adopted), all without cloud credentials, and fail on any error. `terraform plan` and `apply` SHALL NOT run in CI.
- **AC-9** THE VM's cloud-init SHALL install Docker Engine with the Compose plugin, enable automatic security updates, configure SSH for key-only login, install the production Compose file and a systemd unit that starts the stack once the operator has provided the environment file; WHEN CI runs, `cloud-init schema` SHALL validate the rendered cloud-init file. No secret SHALL be passed through Terraform variables, Terraform state or instance metadata.
- **AC-10** `.gitignore` SHALL exclude Terraform state, `.terraform/`, `*.tfvars` (except a committed `terraform.tfvars.example` with placeholder values only) and production environment files; a CI check SHALL fail if any such file is tracked.

### Docs
- **AC-11** `docs/deploy.md` SHALL be an operator runbook covering: prerequisites (Oracle account and its credit-card and capacity caveats from ADR-0012, an OCI API key, Terraform, an SSH key), `terraform init/plan/apply`, providing the environment file over SSH, DNS or hostname for TLS, running `pnpm demo:key`, checking health and dashboards (through an SSH tunnel), upgrading to a new image tag, rolling back, `terraform destroy`, setting a billing alert, and what to do if Always Free ARM capacity is unavailable (fallback recorded in ADR-0022). Steps that have not been run against a real account yet SHALL be marked as such.
- **AC-12** THE README SHALL document how to pull and run the published images (with the platforms supported), link to `docs/deploy.md`, and link to the public demo only once it actually exists; `CHANGELOG.md` SHALL list the changes of every released version from the first `v0.x` tag on.

## Non-goals
- Actually provisioning the Oracle VM as part of this spec's acceptance (the owner has no account yet); the first real apply is an operator task recorded in `docs/deploy.md` when done.
- High availability, multiple VMs, Kubernetes or Helm charts, autoscaling.
- Remote Terraform state backends, OCI Vault or other paid/managed secret stores.
- Publishing to Docker Hub or other registries; image signing (cosign) beyond optional attestations.
- Automatic deployment of new releases to the demo (continuous deployment).
- Running paid models on the public demo; a capped paid key remains an operator's explicit choice (ADR-0012).

## Open questions
- Which reverse proxy terminates TLS? (Proposed: **Caddy**, for automatic Let's Encrypt certificates with a few lines of config and a local-certificate mode for CI; Traefik or nginx + certbot need more configuration for the same result.)
- Which hostname gets the certificate if the operator has no domain? (Proposed: a wildcard-DNS hostname derived from the public IP, such as `<ip>.sslip.io`, documented as the default; a custom domain is a variable.)
- One image with two commands, or separate gateway and worker images? (Proposed: two image names (`switchyard-gateway`, `switchyard-worker`) built from the same `Dockerfile` with different final targets, so they share layers but each has the right default command and health check.)
- How do secrets reach the VM? (Proposed: the operator copies the environment file over SSH as the runbook describes; the systemd unit waits for it. Passing secrets as Terraform variables would put them in state and in instance metadata.)
- Which models does the public demo serve? (Proposed: the `mock` provider plus a small Ollama model on the VM's CPU; free-tier hosted providers only if the operator adds their own keys and sets provider-side spending limits.)
- Where does the demo's telemetry go? (Proposed: `otel-lgtm` on the VM with the dashboards from spec 011, reachable only through an SSH tunnel; Grafana Cloud's free tier stays an option documented in the runbook.)
- Should arm64 images be built with QEMU or on native GitHub-hosted ARM runners? (Proposed: QEMU first, as ADR-0012 assumes; switch to native ARM runners if they are available for public repos and QEMU builds are too slow, without changing the published result.)
