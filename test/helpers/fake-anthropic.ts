/**
 * In-process fake of the Anthropic Messages API (spec 014, AC-15/AC-16), so no test needs a paid
 * key. Shapes follow the Anthropic docs (messages, SSE events, error bodies). Scripted by model:
 * `error-429` / `error-529` / `error-500` fail with that status, `error-midstream` streams some
 * text then an `error` event; anything else answers with text, or calls the first custom tool when
 * tools are offered and the last user turn carries no `tool_result`.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_ANTHROPIC_KEY = "sk-ant-fake-key";
export const FAKE_TEXT = "Hello from fake Claude.";

export interface RecordedAnthropicRequest {
  headers: IncomingHttpHeaders;
  /** Raw request body, for byte-for-byte comparisons. */
  raw: string;
  body: Record<string, unknown>;
}

export interface FakeAnthropic {
  /** Base URL to use as the provider `baseUrl`. */
  url: string;
  requests: RecordedAnthropicRequest[];
  close(): Promise<void>;
}

type Rec = Record<string, unknown>;
const USAGE = {
  input_tokens: 12,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3,
};

const errorBody = (type: string, message: string, id: string) =>
  JSON.stringify({ type: "error", error: { type, message }, request_id: id });

/** The first custom tool to call, or undefined to answer with text. */
function toolToCall(body: Rec): Rec | undefined {
  const tools = Array.isArray(body.tools) ? (body.tools as Rec[]) : [];
  const tool = tools.find((t) => t.type === undefined || t.type === "custom");
  if (!tool) return undefined;
  const messages = Array.isArray(body.messages) ? (body.messages as Rec[]) : [];
  const last = messages.at(-1);
  const content = Array.isArray(last?.content) ? (last.content as Rec[]) : [];
  if (content.some((block) => block.type === "tool_result")) return undefined;
  return tool;
}

function message(body: Rec, n: number): Rec {
  const tool = toolToCall(body);
  return {
    id: `msg_fake_${n}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: tool
      ? [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: `toolu_fake_${n}`, name: tool.name, input: { city: "Paris" } },
        ]
      : [{ type: "text", text: FAKE_TEXT }],
    stop_reason: tool ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: USAGE,
  };
}

function events(body: Rec, n: number): [string, Rec][] {
  const full = message(body, n);
  const out: [string, Rec][] = [
    [
      "message_start",
      {
        message: { ...full, content: [], stop_reason: null, usage: { ...USAGE, output_tokens: 1 } },
      },
    ],
    ["ping", {}],
  ];
  if (body.model === "error-midstream") {
    out.push(["content_block_start", { index: 0, content_block: { type: "text", text: "" } }]);
    out.push(["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Partial" } }]);
    out.push(["error", { error: { type: "overloaded_error", message: "Overloaded" } }]);
    return out;
  }
  (full.content as Rec[]).forEach((block, index) => {
    if (block.type === "text") {
      out.push(["content_block_start", { index, content_block: { type: "text", text: "" } }]);
      const text = String(block.text);
      const half = Math.ceil(text.length / 2);
      for (const piece of [text.slice(0, half), text.slice(half)]) {
        out.push(["content_block_delta", { index, delta: { type: "text_delta", text: piece } }]);
      }
    } else {
      out.push([
        "content_block_start",
        { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
      ]);
      const json = JSON.stringify(block.input);
      for (const piece of [json.slice(0, 5), json.slice(5)]) {
        out.push([
          "content_block_delta",
          { index, delta: { type: "input_json_delta", partial_json: piece } },
        ]);
      }
    }
    out.push(["content_block_stop", { index }]);
  });
  out.push([
    "message_delta",
    {
      delta: { stop_reason: full.stop_reason, stop_sequence: null },
      usage: { output_tokens: USAGE.output_tokens },
    },
  ]);
  out.push(["message_stop", {}]);
  return out;
}

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const requests: RecordedAnthropicRequest[] = [];
  let counter = 0;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      counter += 1;
      const id = `req_fake_${counter}`;
      const reply = (status: number, payload: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", "request-id": id, ...headers });
        res.end(payload);
      };
      let body: Rec;
      try {
        body = JSON.parse(raw) as Rec;
      } catch {
        reply(400, errorBody("invalid_request_error", "invalid JSON", id));
        return;
      }
      requests.push({ headers: req.headers, raw, body });

      if (req.method !== "POST" || req.url !== "/v1/messages") {
        reply(404, errorBody("not_found_error", "Not found", id));
      } else if (req.headers["x-api-key"] !== FAKE_ANTHROPIC_KEY) {
        reply(401, errorBody("authentication_error", "invalid x-api-key", id));
      } else if (req.headers["anthropic-version"] !== "2023-06-01") {
        reply(400, errorBody("invalid_request_error", "anthropic-version required", id));
      } else if (body.model === "error-429") {
        reply(429, errorBody("rate_limit_error", "Rate limited", id), { "retry-after": "7" });
      } else if (body.model === "error-529") {
        reply(529, errorBody("overloaded_error", "Overloaded", id));
      } else if (body.model === "error-500") {
        reply(500, errorBody("api_error", "Internal server error", id));
      } else if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "request-id": id });
        for (const [type, data] of events(body, counter)) {
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        }
        res.end();
      } else {
        reply(200, JSON.stringify(message(body, counter)));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
