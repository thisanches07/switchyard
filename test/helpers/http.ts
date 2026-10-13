import type { HttpClient, HttpResponse, HttpStreamResponse } from "../../src/core/provider.js";

export interface RecordedCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  signal: AbortSignal;
}

type StreamResponder = (call: RecordedCall) => HttpStreamResponse | Promise<HttpStreamResponse>;

/** Fake HttpClient returning scripted responses (or throwing) and recording calls. */
export function fakeHttp(
  respond: () => HttpResponse | Promise<HttpResponse>,
  respondStream?: StreamResponder,
) {
  const calls: RecordedCall[] = [];
  const client: HttpClient = {
    async postJson(url, body, options) {
      calls.push({ url, body, headers: options.headers, signal: options.signal });
      return respond();
    },
    async postStream(url, body, options) {
      const call = { url, body, headers: options.headers, signal: options.signal };
      calls.push(call);
      if (!respondStream) throw new Error("fakeHttp: no stream responder configured");
      return respondStream(call);
    },
  };
  return { client, calls };
}

export const jsonResponse = (status: number, body: unknown): HttpResponse => ({
  status,
  text: JSON.stringify(body),
});

/** A streaming response whose body yields the given parts (strings are UTF-8 encoded). */
export function streamResponse(
  status: number,
  parts: (string | Error)[],
  options: { text?: string } = {},
): HttpStreamResponse {
  return {
    status,
    text: async () => options.text ?? parts.filter((p) => typeof p === "string").join(""),
    body: (async function* () {
      for (const part of parts) {
        if (part instanceof Error) throw part;
        yield new TextEncoder().encode(part);
      }
    })(),
  };
}

/** SSE text for a list of chunk objects, optionally ending with [DONE]. */
export const sse = (chunks: unknown[], done = true): string =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
