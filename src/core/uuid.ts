import { randomBytes } from "node:crypto";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/**
 * UUID version 7 (RFC 9562): 48-bit Unix time in milliseconds, then random bits. Ids sort by
 * creation time, which keeps the `usage_events` primary key index append-mostly (ADR-0007).
 */
export function uuidv7(
  now: number = Date.now(),
  random: (size: number) => Uint8Array = randomBytes,
): string {
  const bytes = new Uint8Array(16);
  let time = Math.floor(now);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes.set(random(10).subarray(0, 10), 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // variant 10
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
