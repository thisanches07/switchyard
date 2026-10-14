// Mock upstream for benchmarks (spec 012, AC-1): the in-process `mock` provider served over HTTP
// as an OpenAI-compatible API, so the gateway reaches it through its `openai-compatible` adapter
// and k6 can call it directly for the baseline. Benchmark-only: never part of the gateway image.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChatRequest, EmbeddingsRequest } from "../../src/core/chat.js";
import { GatewayError } from "../../src/core/errors.js";
import { createMockProvider, type MockProviderConfig } from "../../src/modules/providers/mock.js";

export interface MockUpstreamConfig extends Required<MockProviderConfig> {
  port: number;
}

export interface MockUpstreamOptions {
  /** Source of randomness for `errorRate` (tests pass a seeded one). */
  random?: () => number;
}

const DEFAULTS: MockUpstreamConfig = { latencyMs: 50, chunkDelayMs: 0, errorRate: 0, port: 9100 };

const FLAGS: Record<string, keyof MockUpstreamConfig> = {
  "--latency-ms": "latencyMs",
  "--chunk-delay-ms": "chunkDelayMs",
  "--error-rate": "errorRate",
  "--port": "port",
};

const ENV: Record<string, keyof MockUpstreamConfig> = {
  MOCK_LATENCY_MS: "latencyMs",
  MOCK_CHUNK_DELAY_MS: "chunkDelayMs",
  MOCK_ERROR_RATE: "errorRate",
  PORT: "port",
};

/** Knobs from the environment, overridden by `--flag value` arguments. */
export function parseMockConfig(
  env: Record<string, string | undefined>,
  argv: readonly string[] = [],
): MockUpstreamConfig {
  const config = { ...DEFAULTS };
  for (const [name, key] of Object.entries(ENV)) {
    const value = env[name];
    if (value !== undefined && value !== "") config[key] = parseKnob(name, key, value);
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = FLAGS[argv[i] ?? ""];
    if (!key) continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${argv[i]} needs a value`);
    config[key] = parseKnob(argv[i] ?? "", key, value);
    i += 1;
  }
  return config;
}

function parseKnob(source: string, key: keyof MockUpstreamConfig, raw: string): number {
  const value = Number(raw);
  const valid =
    key === "errorRate"
      ? Number.isFinite(value) && value >= 0 && value <= 1
      : Number.isInteger(value) && value >= 0;
  if (!valid) throw new Error(`${source}: invalid value "${raw}" for ${key}`);
  return value;
}

export function createMockUpstream(
  config: Omit<MockUpstreamConfig, "port">,
  options: MockUpstreamOptions = {},
): Server {
  const provider = createMockProvider(
    "mock-upstream",
    { latencyMs: config.latencyMs, errorRate: config.errorRate, chunkDelayMs: config.chunkDelayMs },
    options.random ? { random: options.random } : {},
  );

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendError(res, 500, "server_error", "mock_internal_error", errorMessage(error));
      } else {
        res.destroy();
      }
    });
  });
  // Above undici's 30 s client keep-alive: the gateway must never reuse a socket the mock is
  // closing, or the race shows up as spurious upstream failures in the benchmark.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/healthz") return sendJson(res, 200, { status: "ok" });
    if (req.method === "GET" && path === "/v1/models") {
      return sendJson(res, 200, { object: "list", data: [] });
    }
    if (req.method !== "POST" || (path !== "/v1/chat/completions" && path !== "/v1/embeddings")) {
      return sendError(res, 404, "invalid_request_error", "not_found", `No route ${path}`);
    }

    const body = await readJson(req);
    if (!isRequest(body)) {
      return sendError(res, 400, "invalid_request_error", "invalid_request", "Invalid body");
    }

    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const ctx = { signal: controller.signal };

    try {
      if (path === "/v1/embeddings") {
        const result = await provider.embeddings(body as unknown as EmbeddingsRequest, ctx);
        return sendJson(res, 200, result.body);
      }
      const request = body as unknown as ChatRequest;
      if (request.stream !== true) {
        const result = await provider.chat(request, ctx);
        return sendJson(res, 200, result.body);
      }
      const stream = await provider.chatStream(request, ctx);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      try {
        for await (const chunk of stream) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } catch {
        // `error-midstream`, or the client went away: cut the connection like a real provider.
        res.destroy();
        return;
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!(error instanceof GatewayError)) throw error;
      const status = failureStatus(body.model, error);
      const type = status >= 500 ? "server_error" : error.type;
      const code = status >= 500 ? "mock_failure" : error.code;
      sendError(res, status, type, code, `Mock upstream failure (${status})`);
    }
  }

  return server;
}

/**
 * HTTP status of a simulated failure: `error-<status>` models get exactly that status; random
 * failures (`errorRate`) get 503, like an overloaded provider.
 */
export function failureStatus(model: string, error: GatewayError): number {
  const forced = /^error-(\d{3})$/.exec(model)?.[1];
  if (forced) return Number(forced);
  return error.status >= 500 ? 503 : error.status;
}

function isRequest(body: unknown): body is { model: string; [key: string]: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { model?: unknown }).model === "string"
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  type: string,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { message, type, code } });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
