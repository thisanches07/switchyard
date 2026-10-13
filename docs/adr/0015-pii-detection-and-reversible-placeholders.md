# 0015. Detect PII with validated patterns and mask it with typed, numbered placeholders

- **Status:** Accepted
- **Date:** 2026-10-13
- **Related specs:** 010, 015

## Context
Spec 010 masks personal data (e-mail, phone, card, CPF, CNPJ, IP, operator deny-list terms) before a request leaves the gateway, and restores the original values in the answer. Two choices shape everything else:

1. **How to detect.** Detection runs on the hot path of every request of a `mask` / `block` key, on inputs up to `server.bodyLimitBytes` (1 MiB). It must add little latency, be bounded on adversarial input (no ReDoS), keep false positives rare (a 16-digit order id is not a card), run on the reference machine (16 GB, no spare GPU memory while Ollama runs) and fit the single-process Node gateway and its Compose stack.
2. **What to replace values with.** The placeholder must keep the prompt useful to the model (it should still understand "the customer's CPF" and refer back to it), and must survive the round trip through the model so the gateway can put the original value back. The model is free to rewrite anything, so restore can only ever be best-effort.

ADR-0010 also applies: original values must never reach logs, spans or storage, which rules out any design that persists the mapping.

## Options considered

### Detection
1. **Own detectors: linear-time patterns plus validators** (Luhn for cards, check digits for CPF/CNPJ, an address parser for IPv6, literal matching for deny-list terms).
   - ✅ Microseconds per KB, in-process, no new service; validators make false positives on CPF/CNPJ/cards rare; fully unit-testable with fixed vectors; Brazilian identifiers are first-class.
   - ⚠️ Only structured identifiers; no names or addresses; each new type is code to write and test.
2. **Microsoft Presidio as a Python sidecar** (analyzer + anonymizer over HTTP).
   - ✅ Mature, many recognizers (including names via spaCy NER), supports custom recognizers and reversible anonymization.
   - ⚠️ A second runtime and container (several hundred MB of RAM with a spaCy model) against the ~4 GB idle budget; a network hop on every request; Brazilian CPF/CNPJ need custom recognizers anyway; a new failure mode (sidecar down: fail open leaks PII, fail closed stops traffic).
3. **An NER model** (e.g. a small transformer for PII, run in-process via ONNX or through Ollama).
   - ✅ Catches unstructured PII (names, addresses) that patterns cannot.
   - ⚠️ Tens to hundreds of milliseconds per request on CPU, GPU memory already used by Ollama, non-deterministic recall that is hard to test with fixed vectors, and still weak on check-digit identifiers that validators get exactly right.

### Placeholder format
1. **Typed, numbered tokens** `<CPF_1>`, `<EMAIL_2>`.
   - ✅ The model sees what kind of value it is and can tell two values apart, so answers stay coherent; tokens are short, contain no JSON-special characters (safe inside tool-call arguments), and are easy to match exactly on restore; deterministic numbering makes tests and (in spec 009) cache keys stable.
   - ⚠️ Models sometimes paraphrase or reformat them (`CPF 1`, `<cpf_1>`), which restore will not recognise; the type leaks to the provider (it learns "there is a CPF here", not which one); a client text that already contains `<CPF_1>` is ambiguous.
2. **Opaque random tokens** (`[[a8f3c1]]`).
   - ✅ Reveal nothing about the value's type; collisions with client text are practically impossible.
   - ⚠️ The model loses meaning ("send the code to [[a8f3c1]]" is harder to reason about), random tokens are more often split or altered by tokenizers, and random output breaks deterministic tests and exact-cache keys.
3. **Format-preserving fake values** (a valid but fake CPF, `user1@example.invalid`).
   - ✅ The most natural prompt for the model; downstream formatting and validation in the answer still work.
   - ⚠️ Restore depends on finding the fake value again, and models reformat values (`529.982.247-25` → `52998224725`) far more than they rewrite tags; a fake value can collide with a real one in the text; a generated "valid" CPF or card may belong to a real person.

## Decision
We will implement **our own detectors** (option 1 for detection) as small pure functions: patterns written to run in linear time (no nested or overlapping unbounded quantifiers, enforced by a test), each candidate confirmed by a validator where one exists, overlaps resolved by "longest match, then validator-backed type wins", and deny-list terms matched as literals, never as user-supplied regular expressions.

We will mask with **typed, numbered placeholders** `<TYPE_n>` (option 1 for format), numbered per type in order of appearance within one request, with the same exact string always mapping to the same placeholder.

The placeholder → value map lives **only in the memory of the request** and is never persisted, logged, traced, cached or published. Restore replaces exact matches of known placeholders and leaves everything else untouched; it is **best-effort**.

Presidio or an NER model can be added later behind the same detector port if unstructured PII (names, addresses) becomes a requirement.

## Consequences
- ✅ Detection adds negligible latency and no new service, and is bounded on adversarial input.
- ✅ Precision on the identifiers that matter most for the target users (CPF, CNPJ, cards) is high thanks to check digits and Luhn, with fixed true/false-positive vectors in tests.
- ✅ No new data store holds personal data; a crashed or restarted gateway leaves nothing behind (ADR-0010).
- ⚠️ Unstructured PII (names, addresses, free-text identifiers) is **not** detected; the docs must say so plainly so operators do not over-trust `mask`.
- ⚠️ Models may paraphrase, reformat or invent placeholders; those are not restored, and the client then sees `<CPF_1>`-like text. The provider still learns the *types* of data present.
- ⚠️ Without a persisted map, restore is impossible across requests: a placeholder the model echoes in a later turn (after the client sent back an unrestored answer) is re-masked or left as-is, not restored from history.
- 🔁 Revisit if operators need name/address detection (add Presidio or an NER detector behind the port), if measured restore failures are frequent with common models (consider normalisation or a different token shape), or if a provider offers native data-masking.
