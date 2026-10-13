import { type GatewayError, upstreamError, upstreamTimeout } from "../../core/errors.js";

/** Maps an aborted call to a gateway error: timeouts → 504, anything else (client gone) → 502. */
export function abortedCallError(provider: string, signal: AbortSignal): GatewayError {
  const reason: unknown = signal.reason;
  const isTimeout = reason instanceof Error && reason.name === "TimeoutError";
  return isTimeout ? upstreamTimeout(provider) : upstreamError(provider);
}
