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
  inputTokens: number;
  outputTokens: number;
}
