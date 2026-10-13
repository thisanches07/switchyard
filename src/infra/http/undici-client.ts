import { Agent, request } from "undici";
import {
  type HttpClient,
  type HttpStreamResponse,
  UpstreamNetworkError,
  UpstreamTimeoutError,
} from "../../core/provider.js";

export interface UpstreamTimeouts {
  connectMs: number;
  /** Time to first byte (response headers); also the idle limit between streamed chunks. */
  ttfbMs: number;
  /** Whole non-streaming call, or a stream until its first body byte. */
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

/** `HttpClient` on a shared undici `Agent` with connect, TTFB, idle and total timeouts. */
export function createUndiciClient(timeouts: UpstreamTimeouts): HttpClient & {
  close(): Promise<void>;
} {
  const agent = new Agent({
    connectTimeout: timeouts.connectMs,
    headersTimeout: timeouts.ttfbMs,
    bodyTimeout: timeouts.totalMs,
    keepAliveTimeout: 30_000,
  });

  /** Normalises transport errors; caller aborts are rethrown untouched. */
  function mapError(error: unknown, total: AbortSignal, caller: AbortSignal): unknown {
    if (caller.aborted) return error;
    if (total.aborted) {
      return new UpstreamTimeoutError(`no response within ${timeouts.totalMs} ms`);
    }
    const code = errorCode(error);
    if (code && TIMEOUT_CODES.has(code)) return new UpstreamTimeoutError(code);
    if (code && NETWORK_CODES.has(code)) return new UpstreamNetworkError(code);
    return error;
  }

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
        return {
          status: res.statusCode,
          text: await res.body.text(),
          headers: flattenHeaders(res.headers),
        };
      } catch (error) {
        throw mapError(error, total, options.signal);
      }
    },

    async postStream(url, body, options): Promise<HttpStreamResponse> {
      // The total limit applies only until the first body byte: long generations are legitimate,
      // and once data flows the idle (between-chunk) limit takes over (spec 003 design §3).
      const totalController = new AbortController();
      const timer = setTimeout(
        () => totalController.abort(new DOMException("total timeout", "TimeoutError")),
        timeouts.totalMs,
      );
      const total = totalController.signal;
      const signal = AbortSignal.any([options.signal, total]);

      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await request(url, {
          method: "POST",
          headers: options.headers,
          body: JSON.stringify(body),
          signal,
          dispatcher: agent,
          bodyTimeout: timeouts.ttfbMs,
        });
      } catch (error) {
        clearTimeout(timer);
        throw mapError(error, total, options.signal);
      }

      const responseBody = res.body;
      async function* bytes(): AsyncGenerator<Uint8Array> {
        let completed = false;
        try {
          for await (const chunk of responseBody) {
            clearTimeout(timer);
            yield chunk as Uint8Array;
          }
          completed = true;
        } catch (error) {
          throw mapError(error, total, options.signal);
        } finally {
          clearTimeout(timer);
          // Consumer stopped early (e.g. client disconnected): release the connection.
          if (!completed) responseBody.destroy();
        }
      }

      return {
        status: res.statusCode,
        headers: flattenHeaders(res.headers),
        text: async () => {
          clearTimeout(timer);
          try {
            return await responseBody.text();
          } catch (error) {
            throw mapError(error, total, options.signal);
          }
        },
        body: bytes(),
      };
    },

    close: () => agent.close(),
  };
}

/** Lower-cased header names, first value of repeated headers. */
function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) flat[name.toLowerCase()] = first;
  }
  return flat;
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
