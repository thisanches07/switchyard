import { describe, expect, it } from "vitest";
import {
  anthropicExtensionOf,
  nativeEventOf,
  withAnthropicExtension,
  withNativeEvent,
} from "../../../src/core/anthropic.js";

describe("Anthropic extension (ADR-0016)", () => {
  const extension = { body: { model: "m" }, slots: [] };
  const request = { model: "m", messages: [{ role: "user", content: "hi" }] };

  it("survives spread but is never serialised", () => {
    const extended = withAnthropicExtension(request, extension);
    const copy = { ...extended, model: "other" };
    expect(anthropicExtensionOf(copy)).toBe(extension);
    expect(JSON.parse(JSON.stringify(copy))).toEqual({ ...request, model: "other" });
  });

  it("is absent on plain requests", () => {
    expect(anthropicExtensionOf(request)).toBeUndefined();
    expect(anthropicExtensionOf(JSON.parse('{"model":"m","messages":[]}'))).toBeUndefined();
  });

  it("native events ride on chunks without being serialised", () => {
    const chunk = withNativeEvent({ choices: [] }, { type: "ping", data: '{"type":"ping"}' });
    expect(nativeEventOf(chunk)).toEqual({ type: "ping", data: '{"type":"ping"}' });
    expect(JSON.stringify(chunk)).toBe('{"choices":[]}');
    expect(nativeEventOf({})).toBeUndefined();
  });
});
