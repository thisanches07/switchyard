# Changelog

All notable changes to Switchyard are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The release workflow
publishes the section whose heading matches the pushed tag as the GitHub Release notes, and fails
if that section is missing (spec 013).

## [Unreleased]

Nothing yet beyond the planned 0.1.0 below.

## [0.1.0] - Unreleased

<!-- Planned first tagged release: replace "Unreleased" in the heading with the date when tagging v0.1.0. -->

### Added
- OpenAI-compatible API: `POST /v1/chat/completions` (with SSE streaming), `POST /v1/embeddings`
  and `GET /v1/models`, with `openai-compatible`, `anthropic` and `mock` provider adapters and the
  OpenAI error shape (specs 002, 003).
- Native Anthropic Messages API `POST /v1/messages` (spec 014).
- Virtual API keys with teams, allowed models per key and an admin API behind `ADMIN_TOKEN`,
  documented at `/docs` (spec 004).
- Per-minute request and token rate limits per key and team in Redis (spec 005).
- Usage event pipeline: gateway → Kafka (Redpanda) → idempotent usage worker → Postgres, with
  `GET /admin/usage` (spec 006).
- Cost per request from `config/pricing.yaml` and monthly budgets with soft and hard limits
  (spec 007).
- Aliases with priority, lowest-cost and lowest-latency strategies, retries before the first byte,
  circuit breakers, timeouts and config hot reload (spec 008).
- PII redaction (`off`, `mask`, `block` per key), including restoring masked values in streamed
  answers (specs 010, 015).
- OpenTelemetry traces and metrics, Docker Compose stack for local development (spec 001).
- Multi-arch (`linux/amd64`, `linux/arm64`) images `ghcr.io/thisanches07/switchyard-gateway` and
  `ghcr.io/thisanches07/switchyard-worker`, a tag-driven release workflow, a production Compose
  profile behind Caddy (TLS), `pnpm demo:key`, Terraform and cloud-init for Oracle Cloud Always
  Free and an operator runbook in `docs/deploy.md` (spec 013).

[Unreleased]: https://github.com/thisanches07/switchyard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/thisanches07/switchyard/releases/tag/v0.1.0
