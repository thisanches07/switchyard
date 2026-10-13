# 0019. Build exact cache keys from a canonical JSON form hashed with SHA-256, scoped by team

- **Status:** Accepted
- **Date:** 2026-10-13
- **Related specs:** 009

## Context
The exact cache (spec 009) serves a stored response when a new request is "the same" as an earlier one. The key decides what "the same" means:
- too loose (ignoring a parameter that changes the output) and a client gets an answer generated for a different request, or another tenant's answer;
- too strict (hashing the raw body) and semantically identical requests miss because of key order, whitespace or fields that do not affect the output (`stream`, `user`).

The same rules also define the semantic cache's `params_hash` (ADR-0009), so both caches agree on what "the same parameters" means. Requests are free-form JSON: the canonical types keep and pass through fields the gateway does not interpret (ADR-0004), so new OpenAI parameters appear without a gateway release.

## Options considered
1. **Hash the raw request body**: trivial, but key order, whitespace and `stream`/`user` cause misses; a streaming and a non-streaming client never share entries.
2. **Canonical JSON over an allowlist of known parameters**: compact keys, but a new output-affecting parameter that is not on the list is silently ignored, so two different requests share an entry. Unsafe by default.
3. **Canonical JSON over the whole request minus a denylist of parameters known not to affect the output**: unknown parameters are included, so they can only cause extra misses, never wrong hits.

## Decision
We will use option 3.

- **Input:** `{ "v": 1, "team": <team id>, "model": <candidate provider/model>, "messages": <messages>, "params": <every other request field> }`, built from the request **as it is sent upstream** (after alias resolution and PII masking, spec 010).
- **Excluded from `params`:** `model` (replaced by the candidate), `stream`, `stream_options`, `user`, `metadata`, `store`, `service_tier`, and `n` when it is `1` (requests with `n > 1` are not cached).
- **Normalisation:** object keys sorted recursively; no insignificant whitespace; numbers in their shortest JSON form; fields whose value is `null` removed from the top level of the request and from each message object (not inside tool schemas or other nested values, where `null` can be meaningful); array order kept everywhere (message, tool and stop-sequence order can change the output); strings kept byte for byte (no trimming, case folding or Unicode normalisation); defaults never filled in (an absent `temperature` is not the same as `1`).
- **Hash:** SHA-256 of the UTF-8 canonical JSON, hex encoded.
- **Redis key:** `sy:cache:exact:v1:<team id>:<candidate>:<hash>`. The team id is both inside the hash input and in the key prefix, so isolation does not rely on a single mechanism and a team's entries can be found by prefix.
- **Semantic `params_hash`:** the same canonical form and hash, with the final user message removed from `messages` and no team or model in the input (those are separate columns, ADR-0009).
- **Versioning:** any change to these rules bumps `v` and the `v1` in the key prefix; old entries are never read again and expire through their TTL.

## Consequences
- ✅ New or unknown parameters can only reduce the hit rate, never produce a wrong hit.
- ✅ Streaming and non-streaming clients, and clients that differ only in key order or `user`, share entries.
- ✅ Cross-tenant hits are impossible by construction, independently of the semantic cache.
- ⚠️ Cosmetically different but equivalent requests (a string `content` vs a one-element text-part array, an explicit default value) still miss; we accept that for simplicity.
- ⚠️ The hash of a guessable prompt could be confirmed by someone with Redis access, who could read the cached responses anyway; Redis stays on a private network.
- 🔁 Revisit if hit-rate measurements (spec 012) show equivalent requests missing often enough to justify more normalisation, or if a provider documents a field in the denylist as output-affecting.
