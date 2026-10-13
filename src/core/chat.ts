/**
 * Canonical chat types (ADR-0004), modelled on the OpenAI chat completions API.
 * Fields the gateway does not interpret are kept and passed through.
 */
export interface ChatMessage {
  role: string;
  [key: string]: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean | undefined;
  [key: string]: unknown;
}

export interface Usage {
  /** All input tokens, including provider prompt-cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported prompt-cache read tokens, part of inputTokens (spec 006). */
  cachedInputTokens?: number | undefined;
}

/** One parsed `chat.completion.chunk` event, forwarded to the client as-is (minus usage rules). */
export type ChatChunk = Record<string, unknown>;

export interface EmbeddingsRequest {
  model: string;
  /** A string, an array of strings, or token arrays; passed through untouched. */
  input: unknown;
  encoding_format?: string | undefined;
  [key: string]: unknown;
}
