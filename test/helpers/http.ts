import type { HttpClient, HttpResponse } from "../../src/core/provider.js";

export interface RecordedCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Fake HttpClient returning a scripted response (or throwing) and recording calls. */
export function fakeHttp(respond: () => HttpResponse | Promise<HttpResponse>) {
  const calls: RecordedCall[] = [];
  const client: HttpClient = {
    async postJson(url, body, options) {
      calls.push({ url, body, headers: options.headers });
      return respond();
    },
  };
  return { client, calls };
}

export const jsonResponse = (status: number, body: unknown): HttpResponse => ({
  status,
  text: JSON.stringify(body),
});
