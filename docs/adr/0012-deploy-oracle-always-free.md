# 0012. Deploy the public demo to Oracle Cloud Always Free with Terraform

- **Status:** Proposed
- **Date:** 2026-10-09
- **Related specs:** 013

## Context
The project needs a public demo at zero cost that can run the whole stack (gateway, worker, Postgres, Redis, Redpanda, telemetry), provisioned as code.

## Options considered
1. **Oracle Cloud Always Free ARM VM (Ampere) + Docker Compose, provisioned with Terraform**: enough RAM for the full stack, one VM, real IaC.
2. **Managed free tiers (Cloud Run + Neon + Upstash + Grafana Cloud)**: no servers to manage, but Kafka has no good free managed option and services sleep when idle.
3. **Paid VM (Hetzner, ~€4/month)**: simplest and most reliable, not free.

## Decision
Use **Oracle Cloud Always Free** (ARM VM) with **Terraform** for network, VM and firewall, and cloud-init to run Docker Compose. Images are multi-arch (amd64 + arm64) and published to **GHCR**. If Always Free ARM capacity is unavailable in the home region, spec 013 picks a fallback (another region, or option 2/3) and records it in a new ADR that supersedes this one.

## Consequences
- ✅ Free, full stack, demonstrates Terraform and multi-arch builds.
- ⚠️ Oracle requires a credit card at signup and Always Free ARM capacity is sometimes unavailable; set billing alerts.
- ⚠️ The public demo must enforce strict rate limits and hard budgets, and use only free/local models unless a capped paid key is configured.
- 🔁 Revisit if the demo needs high availability.
