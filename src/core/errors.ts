/** OpenAI-compatible error body (ADR-0003). */
export interface OpenAiErrorBody {
  error: { message: string; type: string; code: string | null };
}

export function openAiError(message: string, type: string, code: string | null): OpenAiErrorBody {
  return { error: { message, type, code } };
}

/** An error the gateway returns to the client, already mapped to an HTTP status and OpenAI shape. */
export class GatewayError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  /** Extra response headers (e.g. retry-after and x-ratelimit-* on 429). */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Explicit retry classification set by provider adapters (ADR-0004); undefined means
   * "classify by status" (spec 008).
   */
  readonly retryable: boolean | undefined;

  constructor(
    status: number,
    type: string,
    code: string,
    message: string,
    headers: Record<string, string> = {},
    options: { retryable?: boolean | undefined } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.headers = headers;
    this.retryable = options.retryable;
  }

  toBody(): OpenAiErrorBody {
    return openAiError(this.message, this.type, this.code);
  }
}

const INVALID = "invalid_request_error";
const SERVER = "server_error";

export const invalidRequest = (message: string) =>
  new GatewayError(400, INVALID, "invalid_request", message);

export const invalidJson = (detail: string) =>
  new GatewayError(400, INVALID, "invalid_json", `Request body is not valid JSON: ${detail}`);

export const requestTooLarge = () =>
  new GatewayError(413, INVALID, "request_too_large", "Request body is too large");

export const unsupportedMediaType = (contentType: string) =>
  new GatewayError(
    415,
    INVALID,
    "unsupported_media_type",
    `Unsupported content type "${contentType}"; use application/json`,
  );

export const modelNotFound = (model: string) =>
  new GatewayError(404, INVALID, "model_not_found", `The model "${model}" does not exist`);

export const providerNotConfigured = (provider: string, envVar: string) =>
  new GatewayError(
    503,
    SERVER,
    "provider_not_configured",
    `Provider "${provider}" is not configured: environment variable ${envVar} is not set`,
  );

export const upstreamError = (provider: string) =>
  new GatewayError(502, SERVER, "upstream_error", `Provider "${provider}" failed to respond`);

export const upstreamTimeout = (provider: string) =>
  new GatewayError(504, SERVER, "upstream_timeout", `Provider "${provider}" timed out`);

export interface UpstreamErrorFields {
  message?: string | undefined;
  type?: string | undefined;
  code?: string | undefined;
}

/** A 4xx from the provider, passed through so the client can fix its request. */
export const upstreamClientError = (status: number, fields: UpstreamErrorFields) =>
  new GatewayError(
    status,
    fields.type ?? INVALID,
    fields.code ?? `upstream_${status}`,
    fields.message ?? `Provider rejected the request with status ${status}`,
  );

/** Embeddings sent to a provider family that has no embeddings API (spec 014, AC-5). */
export const embeddingsNotSupported = (provider: string) =>
  new GatewayError(
    400,
    INVALID,
    "embeddings_not_supported",
    `Provider "${provider}" does not support embeddings`,
  );

/** A request parameter the target provider cannot honour (ADR-0016). */
export const unsupportedParameter = (param: string, detail: string) =>
  new GatewayError(
    400,
    INVALID,
    "unsupported_parameter",
    `Unsupported parameter "${param}" for this provider: ${detail}`,
  );

/** `x-switchyard-cache` with a value other than `force` or `bypass` (spec 009, AC-2). */
export const invalidCacheHeader = () =>
  new GatewayError(
    400,
    INVALID,
    "invalid_cache_header",
    'x-switchyard-cache must be "force" or "bypass"',
  );

export const invalidToolArguments = (detail: string) =>
  new GatewayError(400, INVALID, "invalid_tool_arguments", detail);

/** The operator's provider key was rejected: a gateway problem, not the client's (spec 014). */
export const upstreamAuthError = (provider: string) =>
  new GatewayError(
    502,
    SERVER,
    "upstream_auth_error",
    `Provider "${provider}" rejected the gateway's credentials`,
    {},
    { retryable: false },
  );

export const upstreamRateLimited = (provider: string, headers: Record<string, string>) =>
  new GatewayError(
    429,
    "rate_limit_error",
    "upstream_rate_limited",
    `Provider "${provider}" is rate limiting requests`,
    headers,
    { retryable: true },
  );

export const upstreamOverloaded = (provider: string) =>
  new GatewayError(
    503,
    SERVER,
    "upstream_overloaded",
    `Provider "${provider}" is overloaded`,
    {},
    { retryable: true },
  );

/** Every allowed candidate has an open circuit breaker (spec 008, AC-9). */
export const noHealthyUpstream = (retryAfterSeconds: number) =>
  new GatewayError(
    503,
    SERVER,
    "no_healthy_upstream",
    "No healthy upstream for this model: every candidate is temporarily disabled after repeated failures",
    { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  );

export const internalError = () =>
  new GatewayError(500, SERVER, "internal_error", "Internal server error");

export const invalidApiKey = () =>
  new GatewayError(
    401,
    INVALID,
    "invalid_api_key",
    "Invalid or missing API key. Send it as Authorization: Bearer sk-sy-…",
  );

export const modelNotAllowed = (model: string) =>
  new GatewayError(403, INVALID, "model_not_allowed", `This API key may not use "${model}"`);

export const invalidAdminToken = () =>
  new GatewayError(401, INVALID, "invalid_admin_token", "Invalid or missing admin token");

export const notFound = (entity: string, id: string) =>
  new GatewayError(404, INVALID, "not_found", `${entity} "${id}" not found`);

export const conflict = (message: string) => new GatewayError(409, INVALID, "conflict", message);

/** 429 in the OpenAI shape: `type` is the limited dimension, as OpenAI reports it (spec 005). */
export const rateLimited = (
  kind: "requests" | "tokens",
  scope: string,
  limit: number,
  headers: Record<string, string>,
) =>
  new GatewayError(
    429,
    kind,
    "rate_limit_exceeded",
    `Rate limit reached for ${kind} (${scope} limit: ${limit} per minute). Retry after the time in retry-after.`,
    headers,
  );

export const requestTooLargeForLimit = (scope: string, capacity: number) =>
  new GatewayError(
    400,
    INVALID,
    "request_too_large_for_limit",
    `This request needs more tokens than the ${scope} limit allows per minute (${capacity}). Lower max_tokens or the input size.`,
  );

export const usageUnavailable = () =>
  new GatewayError(503, SERVER, "usage_unavailable", "Usage reporting is not configured");

/** PII `block` mode (spec 010): names the detected types only, never a value or a position. */
export const piiDetected = (types: readonly string[], headers: Record<string, string> = {}) =>
  new GatewayError(
    400,
    INVALID,
    "pii_detected",
    `Request blocked: personal data detected (${types.join(", ")}). Remove it, or ask the operator to use PII mode "mask" for this key.`,
    headers,
  );

/**
 * Monthly budget exhausted (spec 007, AC-6): `insufficient_quota`, as OpenAI reports exhausted
 * quota, so SDKs raise RateLimitError; `x-should-retry: false` in `headers` stops their retries.
 * Names the scope and the reset time only, never amounts.
 */
export const budgetExceeded = (
  scope: "key" | "team",
  resetAt: string,
  headers: Record<string, string>,
) =>
  new GatewayError(
    429,
    "insufficient_quota",
    "budget_exceeded",
    `Monthly budget exhausted for this ${scope}. It resets at ${resetAt}.`,
    headers,
    { retryable: false },
  );

/** Budget counters unreachable with `budgets.onRedisError: closed` (spec 007, AC-11). */
export const budgetUnavailable = () =>
  new GatewayError(503, SERVER, "budget_unavailable", "Budget check unavailable; try again later");

export const rateLimiterUnavailable = () =>
  new GatewayError(
    503,
    SERVER,
    "rate_limiter_unavailable",
    "Rate limiter unavailable; try again later",
  );
