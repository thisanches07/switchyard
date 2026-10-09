# 0010. Do not persist or log prompt and response content by default

- **Status:** Accepted
- **Date:** 2026-10-09
- **Related specs:** 006, 010, 011

## Context
Prompts often contain personal or confidential data. LGPD and GDPR make storing them a liability, and logs/traces are commonly shipped to third-party tools.

## Options considered
1. **Store nothing by default; opt-in content logging per key, always PII-redacted.**
2. **Store everything for debugging and analytics**: useful, but a privacy and security risk.
3. **Store hashes only**: enough for caching/deduplication, not for debugging.

## Decision
By default Switchyard stores **metadata only** (tokens, cost, latency, status, model, cache status). Content is never written to logs or span attributes. A key can opt in to content logging, in which case content passes through PII redaction first and is stored with a retention TTL. The semantic cache necessarily stores responses and is therefore opt-in per key (ADR-0009).

## Consequences
- ✅ Safe default; simpler compliance story.
- ⚠️ Debugging bad answers needs explicit opt-in.
- 🔁 Revisit if an eval workflow requires sampled content capture.
