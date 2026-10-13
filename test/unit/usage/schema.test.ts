import { describe, expect, it } from "vitest";
import { usageEventSchema } from "../../../src/core/usage.js";
import { sampleEvent } from "../../helpers/usage.js";

const rejects = (input: unknown) => usageEventSchema.safeParse(input).success === false;

describe("UsageEvent v1 schema (spec 006, AC-1)", () => {
  it("accepts a complete event", () => {
    expect(usageEventSchema.parse(sampleEvent())).toEqual(sampleEvent({ id: expect.any(String) }));
  });

  it("accepts every outcome, operation and cache status of the contract", () => {
    for (const outcome of [
      "success",
      "upstream_error",
      "upstream_error_midstream",
      "client_closed",
      "rejected",
    ] as const) {
      expect(rejects(sampleEvent({ outcome }))).toBe(false);
    }
    for (const operation of ["chat", "embeddings", "messages"] as const) {
      expect(rejects(sampleEvent({ operation }))).toBe(false);
    }
    for (const cacheStatus of ["miss", "hit", "semantic_hit", "bypass"] as const) {
      expect(rejects(sampleEvent({ cacheStatus }))).toBe(false);
    }
  });

  it("accepts nullable fields as null and known costs as plain decimals", () => {
    const event = sampleEvent({
      provider: null,
      servedModel: null,
      errorCode: null,
      ttfbMs: null,
      costUsd: "0.0000123400",
      piiDetections: { email: 2 },
    });
    expect(rejects(event)).toBe(false);
    expect(rejects(sampleEvent({ costUsd: "12" }))).toBe(false);
  });

  it("rejects unknown fields (no room for content, ADR-0010)", () => {
    expect(rejects({ ...sampleEvent(), prompt: "hello" })).toBe(true);
  });

  it("rejects a schemaVersion other than 1", () => {
    expect(rejects({ ...sampleEvent(), schemaVersion: 2 })).toBe(true);
  });

  it("rejects an id that is not a UUIDv7", () => {
    expect(rejects(sampleEvent({ id: "550e8400-e29b-41d4-a716-446655440000" }))).toBe(true);
    expect(rejects(sampleEvent({ id: "not-a-uuid" }))).toBe(true);
  });

  it.each(["inputTokens", "outputTokens", "cachedInputTokens", "attempts", "latencyMs"] as const)(
    "rejects a negative %s",
    (field) => {
      expect(rejects(sampleEvent({ [field]: -1 }))).toBe(true);
    },
  );

  it.each(["1e-5", "-1.5", "1.", ".5", "abc", "1,5", " 1"])("rejects costUsd %j", (costUsd) => {
    expect(rejects(sampleEvent({ costUsd }))).toBe(true);
  });

  it("rejects a costUsd number (must be a string or null)", () => {
    expect(rejects({ ...sampleEvent(), costUsd: 0.5 })).toBe(true);
  });

  it("rejects missing fields, bad timestamps and unknown enum values", () => {
    const { requestId: _requestId, ...missing } = sampleEvent();
    expect(rejects(missing)).toBe(true);
    expect(rejects(sampleEvent({ occurredAt: "yesterday" }))).toBe(true);
    expect(rejects({ ...sampleEvent(), outcome: "timeout" })).toBe(true);
    expect(rejects(sampleEvent({ teamId: "team-1" }))).toBe(true);
  });
});
