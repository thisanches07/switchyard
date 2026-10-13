import type { ChatChunk, ChatRequest, EmbeddingsRequest, Usage } from "./chat.js";

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

/**
 * Chunks of a streamed completion. Iterating may throw `GatewayError` mid-stream;
 * such failures are never retried (ADR-0008).
 */
export type ChatStream = AsyncIterable<ChatChunk>;

export interface EmbeddingsResult {
  /** Provider response body (OpenAI `list` of `embedding` objects), returned as-is. */
  body: unknown;
  usage?: { inputTokens: number } | undefined;
  responseModel?: string | undefined;
}

/** A configured upstream (one per entry in `providers:`). Errors are thrown as `GatewayError`. */
export interface ChatProvider {
  readonly name: string;
  readonly type: string;
  chat(request: ChatRequest, ctx: CallContext): Promise<ChatResult>;
  /** Resolves once the stream is open; failures before that reject (safe to retry later). */
  chatStream(request: ChatRequest, ctx: CallContext): Promise<ChatStream>;
  embeddings(request: EmbeddingsRequest, ctx: CallContext): Promise<EmbeddingsResult>;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export interface HttpStreamResponse {
  status: number;
  /** Reads the whole body as text (used for non-2xx responses). */
  text(): Promise<string>;
  /** Raw body bytes; iteration throws `UpstreamTimeoutError` / `UpstreamNetworkError`. */
  body: AsyncIterable<Uint8Array>;
}

export interface HttpRequestOptions {
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** Outbound HTTP port; implemented in infra so modules never depend on undici. */
export interface HttpClient {
  postJson(url: string, body: unknown, options: HttpRequestOptions): Promise<HttpResponse>;
  postStream(url: string, body: unknown, options: HttpRequestOptions): Promise<HttpStreamResponse>;
}

/** Connection refused/reset, DNS failure, connect timeout. */
export class UpstreamNetworkError extends Error {
  override readonly name = "UpstreamNetworkError";
}

/** Headers (TTFB), body or total timeout. */
export class UpstreamTimeoutError extends Error {
  override readonly name = "UpstreamTimeoutError";
}
