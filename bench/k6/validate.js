// Correctness checks for the benchmark (spec 012, AC-4). Pure functions with no k6 imports, so
// the k6 scripts and the Vitest unit tests share them. Each check returns null when the response
// is correct, or a short problem description (never response content: ADR-0010 spirit).

/** What the mock upstream answers (src/modules/providers/mock.ts). */
export const EXPECTED_CONTENT = "This is a mock response.";

/** Headers every gateway response carries (onRequest hook). */
export const BASE_HEADERS = ["x-switchyard-request-id"];
/** Headers of every successful gateway response (spec 008 attempt report). */
export const SUCCESS_HEADERS = [
  "x-switchyard-request-id",
  "x-switchyard-provider",
  "x-switchyard-model",
  "x-switchyard-attempts",
];
/** Successful streams also report the time to first upstream chunk (spec 003). */
export const STREAM_HEADERS = [...SUCCESS_HEADERS, "x-switchyard-ttfb-ms"];

/** Case-insensitive header lookup (k6 canonicalises names, e.g. `X-Switchyard-Model`). */
export function header(headers, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === wanted) {
      const value = headers[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

export function missingHeaders(headers, names) {
  return names.filter((name) => {
    const value = header(headers, name);
    return value === undefined || value === "";
  });
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/** A non-streaming chat completion with the mock's answer. */
export function checkChatCompletion(bodyText) {
  const parsed = parseJson(bodyText);
  if (!parsed.ok) return "body is not JSON";
  const body = parsed.value;
  if (body?.object !== "chat.completion") return "object is not chat.completion";
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (!choice) return "no choices";
  if (choice.message?.content !== EXPECTED_CONTENT) return "unexpected message content";
  if (choice.finish_reason !== "stop") return "unexpected finish_reason";
  if (typeof body.usage?.total_tokens !== "number") return "missing usage";
  return null;
}

/** An SSE stream of chat.completion.chunk events ending in `data: [DONE]`. */
export function checkSseStream(bodyText) {
  if (typeof bodyText !== "string" || bodyText.length === 0) return "empty stream";
  const data = [];
  for (const line of bodyText.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) return "line outside a data field";
    data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return "no events";
  if (data[data.length - 1] !== "[DONE]") return "stream does not end with [DONE]";
  let content = "";
  let finished = false;
  for (const payload of data.slice(0, -1)) {
    if (payload === "[DONE]") return "[DONE] before the end";
    const parsed = parseJson(payload);
    if (!parsed.ok) return "event is not JSON";
    const event = parsed.value;
    if (event?.error) return "error event in stream";
    if (event?.object !== "chat.completion.chunk") return "event is not a chat.completion.chunk";
    const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
    if (typeof choice?.delta?.content === "string") content += choice.delta.content;
    if (choice?.finish_reason === "stop") finished = true;
  }
  if (!finished) return "no finish_reason stop";
  if (content !== EXPECTED_CONTENT) return "reassembled content differs";
  return null;
}

/** OpenAI error shape `{ error: { message, type, code } }`. */
export function checkErrorBody(bodyText) {
  const parsed = parseJson(bodyText);
  if (!parsed.ok) return "error body is not JSON";
  const error = parsed.value?.error;
  if (typeof error?.message !== "string" || typeof error?.type !== "string") {
    return "error body lacks message or type";
  }
  if (!(typeof error.code === "string" || error.code === null)) return "error code malformed";
  return null;
}

/** A 429 from the gateway's rate limiter: `retry-after` of at least one second. */
export function checkRetryAfter(headers) {
  const value = Number(header(headers, "retry-after"));
  return Number.isInteger(value) && value >= 1 ? null : "missing or invalid retry-after";
}

/** `x-switchyard-cache` (spec 009): "hit", "miss", "absent" or "invalid" (anything else). */
export function cacheStatus(headers) {
  const value = header(headers, "x-switchyard-cache");
  if (value === undefined || value === "") return "absent";
  if (value === "hit" || value === "miss") return value;
  return "invalid";
}
