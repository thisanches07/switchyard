import type { UsageEvent } from "../../src/core/usage.js";
import { uuidv7 } from "../../src/core/uuid.js";

/** A valid UsageEvent v1 (spec 006) with overridable fields. */
export function sampleEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: uuidv7(),
    schemaVersion: 1,
    occurredAt: "2026-10-13T12:00:00.000Z",
    requestId: "req_0b7d3c1e-0000-4000-8000-000000000000",
    teamId: "6f1c2b8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f",
    keyId: "0c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
    operation: "chat",
    stream: false,
    requestedModel: "fast",
    provider: "mock",
    servedModel: "fast-model",
    inputTokens: 12,
    outputTokens: 6,
    cachedInputTokens: 0,
    estimated: false,
    costUsd: null,
    status: 200,
    outcome: "success",
    errorCode: null,
    latencyMs: 42,
    ttfbMs: null,
    attempts: 1,
    cacheStatus: "miss",
    piiDetections: {},
    ...overrides,
  };
}
