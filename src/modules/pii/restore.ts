import { PLACEHOLDER_PATTERN, type RestoreMap } from "./placeholder.js";

/**
 * Puts original values back in place of known placeholders (spec 010, AC-8). Best effort
 * (ADR-0015): unknown (`<CPF_9>`) or altered (`<cpf_1>`, `CPF_1`) placeholders are left as is.
 * With `json`, values are inserted JSON-escaped, for use inside JSON strings.
 */
export function restoreText(text: string, map: RestoreMap, json = false): string {
  if (map.size === 0 || !text.includes("<")) return text;
  return text.replace(PLACEHOLDER_PATTERN, (token) => {
    const value = map.get(token);
    if (value === undefined) return token;
    return json ? JSON.stringify(value).slice(1, -1) : value;
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function restoreMessage(message: Record<string, unknown>, map: RestoreMap) {
  const next = { ...message };
  if (typeof message.content === "string") {
    next.content = restoreText(message.content, map);
  } else if (Array.isArray(message.content)) {
    next.content = message.content.map((part: unknown) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? { ...part, text: restoreText(part.text, map) }
        : part,
    );
  }
  if (Array.isArray(message.tool_calls)) {
    next.tool_calls = message.tool_calls.map((call: unknown) => {
      if (!isRecord(call) || !isRecord(call.function)) return call;
      const args = call.function.arguments;
      if (typeof args !== "string") return call;
      return { ...call, function: { ...call.function, arguments: restoreText(args, map, true) } };
    });
  }
  return next;
}

/**
 * Restores `choices[].message.content` and `choices[].message.tool_calls[].function.arguments`
 * of a non-streaming chat completion. Returns a new body; anything not shaped as expected is
 * returned untouched, and this never throws (a provider body must never turn into a 500).
 */
export function restoreChatResponse(body: unknown, map: RestoreMap): unknown {
  if (map.size === 0 || !isRecord(body) || !Array.isArray(body.choices)) return body;
  try {
    return {
      ...body,
      choices: body.choices.map((choice: unknown) =>
        isRecord(choice) && isRecord(choice.message)
          ? { ...choice, message: restoreMessage(choice.message, map) }
          : choice,
      ),
    };
  } catch {
    return body;
  }
}
