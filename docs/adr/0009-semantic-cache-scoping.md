# 0009. Scope the semantic cache by team, model and parameter shape

- **Status:** Proposed
- **Date:** 2026-10-09
- **Related specs:** 009

## Context
A semantic cache returns a stored answer for a *similar* prompt. Shared naively, it can leak one tenant's answers (and the data embedded in them) to another tenant, or return answers generated with different settings.

## Options considered
1. **Global cache**: highest hit rate, unacceptable cross-tenant leakage risk.
2. **Scope by team + resolved model + hash of relevant params** (`temperature`, `tools`, `response_format`, system prompt): safe, lower hit rate.
3. **Scope by API key**: safest, hit rate too low to be useful.

## Decision
Scope semantic cache entries by **team id + resolved model + params hash**, and enable it **per key (opt-in)**. Requests with `temperature > 0.3` or tool calls bypass the semantic cache by default. Similarity threshold defaults to **0.95** (cosine), configurable, and its quality impact is measured with an eval dataset before publishing savings numbers.

## Consequences
- ✅ No cross-tenant leakage by construction; covered by an explicit test.
- ⚠️ Lower hit rate than a global cache.
- ⚠️ Similar-but-different prompts can still get a wrong answer; the threshold and the evals are the mitigation.
- 🔁 Revisit thresholds after the eval platform (portfolio project 2) is available.
