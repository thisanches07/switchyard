import type { ChatRequest, Usage } from "./chat.js";

export interface CallContext {
  /** Aborts on client disconnect or total timeout. */
  signal: AbortSignal;
}

export interface ChatResult {
  /** Provider response body in OpenAI `chat.completion` format, returned to the client as-is. */
  body: unknown;
  usage?: Usage | undefined;
  responseModel?: string | undefined;
}

/** A configured upstream (one per entry in `providers:`). Errors are thrown as `GatewayError`. */
export interface ChatProvider {
  readonly name: string;
  readonly type: string;
  chat(request: ChatRequest, ctx: CallContext): Promise<ChatResult>;
}

export interface HttpResponse {
  status: number;
  text: string;
}

/** Outbound HTTP port; implemented in infra so modules never depend on undici. */
export interface HttpClient {
  postJson(
    url: string,
    body: unknown,
    options: { headers: Record<string, string>; signal: AbortSignal },
  ): Promise<HttpResponse>;
}

/** Connection refused/reset, DNS failure, connect timeout. */
export class UpstreamNetworkError extends Error {
  override readonly name = "UpstreamNetworkError";
}

/** Headers (TTFB), body or total timeout. */
export class UpstreamTimeoutError extends Error {
  override readonly name = "UpstreamTimeoutError";
}
