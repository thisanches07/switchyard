import { setTimeout as sleep } from "node:timers/promises";
import type { ChatChunk, ChatRequest, EmbeddingsRequest } from "../../core/chat.js";
import { upstreamClientError, upstreamError } from "../../core/errors.js";
import type {
  CallContext,
  ChatProvider,
  ChatResult,
  ChatStream,
  EmbeddingsResult,
} from "../../core/provider.js";
import { abortedCallError } from "./abort.js";

export interface MockProviderConfig {
  latencyMs: number;
  errorRate: number;
  /** Delay between streamed chunks. */
  chunkDelayMs?: number;
}

export interface MockProviderOptions {
  random?: () => number;
}

const CONTENT = "This is a mock response.";
const PIECES = ["This", " is", " a", " mock", " response."];
const COMPLETION_TOKENS = 6;
const ECHO_MODEL = "echo";
/** Matches the embedding model fixed in ADR-0005 (nomic-embed-text). */
const EMBEDDING_DIMENSIONS = 768;

/**
 * Deterministic provider for tests and benchmarks (specs 002 and 003).
 * Models named `error-<status>` fail with that upstream status before responding;
 * `error-midstream` fails after the first streamed chunk; `echo` answers with the text of the
 * last user message (spec 010: shows what the provider received, e.g. PII placeholders).
 */
export function createMockProvider(
  name: string,
  config: MockProviderConfig,
  options: MockProviderOptions = {},
): ChatProvider {
  const random = options.random ?? Math.random;
  const chunkDelayMs = config.chunkDelayMs ?? 0;
  let counter = 0;

  async function wait(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) {
      if (signal.aborted) throw abortedCallError(name, signal);
      return;
    }
    try {
      await sleep(ms, undefined, { signal });
    } catch {
      throw abortedCallError(name, signal);
    }
  }

  /** Simulated provider latency and failures that happen before any response. */
  async function beforeResponse(model: string, signal: AbortSignal): Promise<void> {
    await wait(config.latencyMs, signal);
    const forced = /^error-(\d{3})$/.exec(model)?.[1];
    if (forced) throw simulatedFailure(name, Number(forced));
    if (random() < config.errorRate) throw upstreamError(name);
  }

  return {
    name,
    type: "mock",

    async chat(request: ChatRequest, ctx: CallContext): Promise<ChatResult> {
      await beforeResponse(request.model, ctx.signal);
      const inputTokens = Math.ceil(contentLength(request) / 4);
      const content = request.model === ECHO_MODEL ? lastUserText(request) : CONTENT;
      counter += 1;
      return {
        body: {
          id: `chatcmpl-mock-${counter}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: COMPLETION_TOKENS,
            total_tokens: inputTokens + COMPLETION_TOKENS,
          },
        },
        usage: { inputTokens, outputTokens: COMPLETION_TOKENS },
        responseModel: request.model,
      };
    },

    async chatStream(request: ChatRequest, ctx: CallContext): Promise<ChatStream> {
      await beforeResponse(request.model, ctx.signal);
      counter += 1;
      const base = {
        id: `chatcmpl-mock-${counter}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
      };
      const chunk = (delta: Record<string, unknown>, finish: string | null): ChatChunk => ({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const wantsUsage = includeUsage(request);
      const inputTokens = Math.ceil(contentLength(request) / 4);
      const failMidstream = request.model === "error-midstream";

      return (async function* () {
        const chunks: ChatChunk[] = [
          chunk({ role: "assistant", content: "" }, null),
          ...(request.model === ECHO_MODEL ? echoPieces(lastUserText(request)) : PIECES).map(
            (piece) => chunk({ content: piece }, null),
          ),
          chunk({}, "stop"),
        ];
        if (wantsUsage) {
          chunks.push({
            ...base,
            choices: [],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: COMPLETION_TOKENS,
              total_tokens: inputTokens + COMPLETION_TOKENS,
            },
          });
        }
        for (const [index, next] of chunks.entries()) {
          if (index > 0) await wait(chunkDelayMs, ctx.signal);
          if (failMidstream && index === 2) throw upstreamError(name);
          yield next;
        }
      })();
    },

    async embeddings(request: EmbeddingsRequest, ctx: CallContext): Promise<EmbeddingsResult> {
      await beforeResponse(request.model, ctx.signal);
      const inputs = toTexts(request.input);
      const base64 = request.encoding_format === "base64";
      const promptTokens = inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
      return {
        body: {
          object: "list",
          data: inputs.map((text, index) => {
            const vector = embed(text);
            return {
              object: "embedding",
              index,
              embedding: base64 ? toBase64(vector) : vector,
            };
          }),
          model: request.model,
          usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
        },
        usage: { inputTokens: promptTokens },
        responseModel: request.model,
      };
    },
  };
}

function includeUsage(request: ChatRequest): boolean {
  const options = request.stream_options;
  return (
    typeof options === "object" &&
    options !== null &&
    (options as { include_usage?: unknown }).include_usage === true
  );
}

/** Text of the last user message: string content, or its `type: "text"` parts joined. */
function lastUserText(request: ChatRequest): string {
  const last = request.messages.findLast((m) => m.role === "user");
  if (typeof last?.content === "string") return last.content;
  if (!Array.isArray(last?.content)) return "";
  return last.content
    .map((part: unknown) => {
      const { type, text } = (part ?? {}) as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? text : "";
    })
    .join("");
}

/** Splits echoed text into about three pieces, so streams have several content chunks. */
function echoPieces(text: string): string[] {
  const size = Math.max(1, Math.ceil(text.length / 3));
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

function contentLength(request: ChatRequest): number {
  return request.messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
}

function toTexts(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) {
    return input.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
  }
  return [JSON.stringify(input)];
}

/** Deterministic unit vector: FNV-1a hash of the text seeds a mulberry32 PRNG. */
function embed(text: string): number[] {
  let seed = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => next() * 2 - 1);
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => v / norm);
}

/** OpenAI's base64 format: little-endian float32 bytes. */
function toBase64(vector: number[]): string {
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

function simulatedFailure(provider: string, status: number) {
  if (status >= 500) return upstreamError(provider);
  if (status === 429) {
    return upstreamClientError(429, {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "Mock rate limit",
    });
  }
  return upstreamClientError(status, { message: `Mock failure with status ${status}` });
}
