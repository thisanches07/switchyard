/**
 * Anthropic errors → `GatewayError` with an explicit retry classification (spec 014, AC-13).
 * Pure. Upstream 5xx bodies and auth details are never forwarded.
 */
import { z } from "zod";
import {
  GatewayError,
  upstreamAuthError,
  upstreamError,
  upstreamOverloaded,
  upstreamRateLimited,
  upstreamTimeout,
} from "../../core/errors.js";
import type { HttpHeaders } from "../../core/provider.js";

const errorBody = z.looseObject({
  error: z.looseObject({
    type: z.string().optional().catch(undefined),
    message: z.string().optional().catch(undefined),
  }),
});

/** Anthropic `error.type` → the HTTP status Anthropic documents for it. */
const TYPE_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

export function markRetryable(error: GatewayError, retryable: boolean): GatewayError {
  return new GatewayError(
    error.status,
    error.type,
    error.code,
    error.message,
    { ...error.headers },
    {
      retryable,
    },
  );
}

function parse(text: string): z.infer<typeof errorBody>["error"] {
  try {
    const parsed = errorBody.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error : {};
  } catch {
    return {};
  }
}

function fromFields(
  provider: string,
  status: number,
  fields: { type?: string | undefined; message?: string | undefined },
  headers: HttpHeaders,
): GatewayError {
  if (status === 401) return upstreamAuthError(provider);
  if (status === 429) {
    const retryAfter = headers["retry-after"];
    return upstreamRateLimited(provider, retryAfter ? { "retry-after": retryAfter } : {});
  }
  if (status === 529) return upstreamOverloaded(provider);
  if (status === 504) return markRetryable(upstreamTimeout(provider), true);
  if (status >= 400 && status < 500) {
    return new GatewayError(
      status,
      fields.type ?? "invalid_request_error",
      `upstream_${status}`,
      fields.message ?? `Provider rejected the request with status ${status}`,
      {},
      { retryable: false },
    );
  }
  return markRetryable(upstreamError(provider), true);
}

/** A non-2xx HTTP response from `POST /v1/messages`. */
export function errorFromStatus(
  provider: string,
  status: number,
  text: string,
  headers: HttpHeaders = {},
): GatewayError {
  return fromFields(provider, status, parse(text), headers);
}

/** An `event: error` in the SSE stream (payload `{"type":"error","error":{…}}`). */
export function errorFromEvent(provider: string, data: unknown): GatewayError {
  const parsed = errorBody.safeParse(data);
  const fields = parsed.success ? parsed.data.error : {};
  const status = (fields.type && TYPE_STATUS[fields.type]) || 500;
  return fromFields(provider, status, fields, {});
}
