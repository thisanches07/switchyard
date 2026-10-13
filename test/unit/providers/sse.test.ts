import { describe, expect, it } from "vitest";
import { decodeSse } from "../../../src/modules/providers/sse.js";

async function* bytes(parts: string[]) {
  for (const part of parts) yield new TextEncoder().encode(part);
}

async function collect(parts: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const data of decodeSse(bytes(parts))) out.push(data);
  return out;
}

describe("decodeSse", () => {
  it("yields the data of each event", async () => {
    expect(await collect(['data: {"a":1}\n\ndata: {"a":2}\n\n'])).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("handles events split across arbitrary byte boundaries", async () => {
    const text = 'data: {"a":1}\n\ndata: {"b":"é"}\n\n';
    const encoded = new TextEncoder().encode(text);
    async function* oneByteAtATime() {
      for (const byte of encoded) yield new Uint8Array([byte]);
    }
    const out: string[] = [];
    for await (const data of decodeSse(oneByteAtATime())) out.push(data);
    expect(out).toEqual(['{"a":1}', '{"b":"é"}']);
  });

  it("accepts CRLF line endings, including CR and LF split across chunks", async () => {
    expect(await collect(['data: {"a":1}\r', "\n\r\n", 'data: {"a":2}\r\n\r\n'])).toEqual([
      '{"a":1}',
      '{"a":2}',
    ]);
  });

  it("ignores comments and non-data fields", async () => {
    expect(await collect([": keep-alive\n\nevent: message\nid: 7\ndata: x\n\n"])).toEqual(["x"]);
  });

  it("joins multi-line data with newlines", async () => {
    expect(await collect(["data: line1\ndata: line2\n\n"])).toEqual(["line1\nline2"]);
  });

  it("accepts data without a space after the colon", async () => {
    expect(await collect(["data:x\n\n"])).toEqual(["x"]);
  });

  it("stops at [DONE]", async () => {
    expect(await collect(["data: a\n\ndata: [DONE]\n\ndata: b\n\n"])).toEqual(["a"]);
  });

  it("flushes a final event without a trailing blank line", async () => {
    expect(await collect(["data: a\n\ndata: b"])).toEqual(["a", "b"]);
  });
});
