import { describe, expect, it } from "vitest";
import {
  conflict,
  embeddingsNotSupported,
  GatewayError,
  internalError,
  invalidAdminToken,
  invalidApiKey,
  invalidJson,
  invalidRequest,
  invalidToolArguments,
  modelNotAllowed,
  modelNotFound,
  notFound,
  providerNotConfigured,
  requestTooLarge,
  unsupportedMediaType,
  unsupportedParameter,
  upstreamAuthError,
  upstreamClientError,
  upstreamError,
  upstreamOverloaded,
  upstreamRateLimited,
  upstreamTimeout,
} from "../../../src/core/errors.js";

describe("gateway errors", () => {
  it.each([
    [invalidRequest("messages: Required"), 400, "invalid_request_error", "invalid_request"],
    [invalidJson("Unexpected token"), 400, "invalid_request_error", "invalid_json"],
    [requestTooLarge(), 413, "invalid_request_error", "request_too_large"],
    [unsupportedMediaType("text/plain"), 415, "invalid_request_error", "unsupported_media_type"],
    [modelNotFound("gpt-9"), 404, "invalid_request_error", "model_not_found"],
    [providerNotConfigured("groq", "GROQ_API_KEY"), 503, "server_error", "provider_not_configured"],
    [upstreamError("groq"), 502, "server_error", "upstream_error"],
    [upstreamTimeout("groq"), 504, "server_error", "upstream_timeout"],
    [internalError(), 500, "server_error", "internal_error"],
  ])("%s has status %i, type %s, code %s", (error, status, type, code) => {
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.status).toBe(status);
    expect(error.toBody()).toEqual({ error: { message: error.message, type, code } });
  });

  it("modelNotFound names the model", () => {
    expect(modelNotFound("gpt-9").message).toContain('"gpt-9"');
  });

  it("providerNotConfigured names the variable", () => {
    expect(providerNotConfigured("groq", "GROQ_API_KEY").message).toContain("GROQ_API_KEY");
  });

  it("upstreamClientError keeps upstream status, type, code and message", () => {
    const error = upstreamClientError(429, {
      type: "rate_limit_error",
      code: "rate_limited",
      message: "slow down",
    });
    expect(error.status).toBe(429);
    expect(error.toBody()).toEqual({
      error: { message: "slow down", type: "rate_limit_error", code: "rate_limited" },
    });
  });

  it("upstreamClientError falls back to generic type and code", () => {
    const error = upstreamClientError(422, { message: "bad field" });
    expect(error.toBody()).toEqual({
      error: { message: "bad field", type: "invalid_request_error", code: "upstream_422" },
    });
  });

  it("internalError never exposes details", () => {
    expect(internalError().message).toBe("Internal server error");
  });
});

describe("auth and admin errors (spec 004)", () => {
  it.each([
    [invalidApiKey(), 401, "invalid_api_key"],
    [modelNotAllowed("smart"), 403, "model_not_allowed"],
    [invalidAdminToken(), 401, "invalid_admin_token"],
    [notFound("Team", "x"), 404, "not_found"],
    [conflict("dup"), 409, "conflict"],
  ])("%s → %i %s", (error, status, code) => {
    expect(error.status).toBe(status);
    expect(error.toBody().error).toMatchObject({ type: "invalid_request_error", code });
  });
});

describe("Anthropic adapter errors (spec 014)", () => {
  it.each([
    [embeddingsNotSupported("claude"), 400, "invalid_request_error", "embeddings_not_supported"],
    [unsupportedParameter("n", "n > 1"), 400, "invalid_request_error", "unsupported_parameter"],
    [invalidToolArguments("bad"), 400, "invalid_request_error", "invalid_tool_arguments"],
    [upstreamAuthError("claude"), 502, "server_error", "upstream_auth_error"],
    [upstreamRateLimited("claude", {}), 429, "rate_limit_error", "upstream_rate_limited"],
    [upstreamOverloaded("claude"), 503, "server_error", "upstream_overloaded"],
  ])("%s → %i %s %s", (error, status, type, code) => {
    expect(error.status).toBe(status);
    expect(error.toBody().error).toMatchObject({ type, code });
  });

  it("names the provider or parameter", () => {
    expect(embeddingsNotSupported("claude").message).toContain('"claude"');
    expect(unsupportedParameter("logprobs", "not supported").message).toContain("logprobs");
  });

  it("retryable is undefined by default and settable", () => {
    expect(upstreamError("x").retryable).toBeUndefined();
    expect(upstreamOverloaded("x").retryable).toBe(true);
    expect(upstreamRateLimited("x", {}).retryable).toBe(true);
    expect(upstreamAuthError("x").retryable).toBe(false);
    const error = new GatewayError(400, "t", "c", "m", {}, { retryable: false });
    expect(error.retryable).toBe(false);
  });

  it("upstreamRateLimited keeps retry-after", () => {
    expect(upstreamRateLimited("claude", { "retry-after": "7" }).headers).toEqual({
      "retry-after": "7",
    });
  });
});
