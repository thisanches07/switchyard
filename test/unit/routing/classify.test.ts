import { describe, expect, it } from "vitest";
import {
  GatewayError,
  providerNotConfigured,
  upstreamAuthError,
  upstreamClientError,
  upstreamError,
  upstreamOverloaded,
  upstreamRateLimited,
  upstreamTimeout,
} from "../../../src/core/errors.js";
import { classifyFailure } from "../../../src/modules/routing/classify.js";

const status = (code: number) => new GatewayError(code, "t", `s${code}`, "m");

describe("classifyFailure (spec 008, AC-3)", () => {
  it.each([408, 429, 500, 502, 503, 504, 529])("status %i is retryable", (code) => {
    expect(classifyFailure(status(code))).toBe("retryable");
  });

  it.each([400, 401, 403, 404, 409, 413, 422])("status %i is non-retryable", (code) => {
    expect(classifyFailure(status(code))).toBe("non_retryable");
  });

  it("upstream timeouts are their own class", () => {
    expect(classifyFailure(upstreamTimeout("p"))).toBe("timeout");
  });

  it("an explicit retryable flag wins over the status rule (spec 014)", () => {
    expect(classifyFailure(upstreamAuthError("p"))).toBe("non_retryable");
    expect(classifyFailure(upstreamOverloaded("p"))).toBe("retryable");
    expect(classifyFailure(upstreamRateLimited("p", {}))).toBe("retryable");
    const forced = new GatewayError(400, "t", "c", "m", {}, { retryable: true });
    expect(classifyFailure(forced)).toBe("retryable");
  });

  it("classifies provider errors as the adapters build them", () => {
    expect(classifyFailure(upstreamError("p"))).toBe("retryable");
    expect(classifyFailure(upstreamClientError(429, {}))).toBe("retryable");
    expect(classifyFailure(upstreamClientError(400, {}))).toBe("non_retryable");
    // A candidate without its API key falls through to the next one.
    expect(classifyFailure(providerNotConfigured("p", "P_KEY"))).toBe("retryable");
  });

  it("anything that is not a GatewayError is non-retryable", () => {
    expect(classifyFailure(new Error("bug"))).toBe("non_retryable");
    expect(classifyFailure("x")).toBe("non_retryable");
  });
});
