import { Writable } from "node:stream";

/** A pino destination that keeps every JSON log line in memory. */
export function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { stream, lines };
}
