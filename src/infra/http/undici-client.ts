import { Agent, request } from "undici";
import {
  type HttpClient,
  UpstreamNetworkError,
  UpstreamTimeoutError,
} from "../../core/provider.js";

export interface UpstreamTimeouts {
  connectMs: number;
  /** Time to first byte (response headers). */
  ttfbMs: number;
  totalMs: number;
}

const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const NETWORK_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EPIPE",
]);

/** `HttpClient` on a shared undici `Agent` with connect, TTFB and total timeouts. */
export function createUndiciClient(timeouts: UpstreamTimeouts): HttpClient & {
  close(): Promise<void>;
} {
  const agent = new Agent({
    connectTimeout: timeouts.connectMs,
    headersTimeout: timeouts.ttfbMs,
    bodyTimeout: timeouts.totalMs,
    keepAliveTimeout: 30_000,
  });

  return {
    async postJson(url, body, options) {
      const total = AbortSignal.timeout(timeouts.totalMs);
      const signal = AbortSignal.any([options.signal, total]);
      try {
        const res = await request(url, {
          method: "POST",
          headers: options.headers,
          body: JSON.stringify(body),
          signal,
          dispatcher: agent,
        });
        return { status: res.statusCode, text: await res.body.text() };
      } catch (error) {
        if (total.aborted && !options.signal.aborted) {
          throw new UpstreamTimeoutError(`no complete response within ${timeouts.totalMs} ms`);
        }
        if (options.signal.aborted) throw error;
        const code = errorCode(error);
        if (code && TIMEOUT_CODES.has(code)) throw new UpstreamTimeoutError(code);
        if (code && NETWORK_CODES.has(code)) throw new UpstreamNetworkError(code);
        throw error;
      }
    },
    async postStream() {
      throw new Error("postStream is implemented in spec 003 task T5");
    },
    close: () => agent.close(),
  };
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  // undici wraps socket errors; look through `cause` for the first code.
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}
