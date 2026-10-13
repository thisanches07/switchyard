/**
 * Decodes a Server-Sent Events byte stream into the `data` payload of each event.
 * Tolerant of CRLF, comments, multi-line data and arbitrary chunk boundaries.
 * Stops at the OpenAI terminator `data: [DONE]`.
 */
export async function* decodeSse(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const bytes of source) {
    buffer += decoder.decode(bytes, { stream: true });
    // Keep a trailing "\r" until the next chunk: it may be the first half of "\r\n".
    const keepCr = buffer.endsWith("\r");
    const text = (keepCr ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n");
    const events = text.split("\n\n");
    buffer = (events.pop() ?? "") + (keepCr ? "\r" : "");

    for (const event of events) {
      const data = eventData(event);
      if (data === undefined) continue;
      if (data === "[DONE]") return;
      yield data;
    }
  }

  buffer += decoder.decode();
  const data = eventData(buffer.replace(/\r\n?/g, "\n"));
  if (data !== undefined && data !== "[DONE]") yield data;
}

function eventData(event: string): string | undefined {
  const lines: string[] = [];
  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    lines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}
