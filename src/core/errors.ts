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

  constructor(status: number, type: string, code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.type = type;
    this.code = code;
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

export const providerNotImplemented = (provider: string, type: string) =>
  new GatewayError(
    501,
    SERVER,
    "provider_not_implemented",
    `Provider "${provider}" of type "${type}" is not implemented yet`,
  );

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
