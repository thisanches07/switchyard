import { describe, expect, it } from "vitest";
import {
  displayPrefix,
  generateKey,
  hashKey,
  KEY_PREFIX,
  parseBearer,
} from "../../../src/modules/auth/keys.js";

const pepper = "test-pepper-0123456789abcdefghijklmnop";

describe("API key primitives", () => {
  it("generates sk-sy- keys with at least 43 base62 characters of randomness", () => {
    const key = generateKey();
    expect(KEY_PREFIX).toBe("sk-sy-");
    expect(key).toMatch(/^sk-sy-[0-9A-Za-z]{43,}$/);
  });

  it("generates distinct keys", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateKey()));
    expect(keys.size).toBe(200);
  });

  it("encodes the random bytes deterministically (fixed length even with leading zeros)", () => {
    expect(generateKey(() => Buffer.alloc(32, 0))).toBe(`sk-sy-${"0".repeat(43)}`);
    expect(generateKey(() => Buffer.alloc(32, 255))).toMatch(/^sk-sy-[0-9A-Za-z]{43}$/);
  });

  it("hashes with SHA-256 over pepper + key as 64 hex characters", () => {
    const key = "sk-sy-abc";
    const hash = hashKey(pepper, key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(pepper, key)).toBe(hash);
    expect(hashKey(`${pepper}x`, key)).not.toBe(hash);
    expect(hashKey(pepper, "sk-sy-abd")).not.toBe(hash);
  });

  it("keeps a short, non-secret display prefix", () => {
    expect(displayPrefix("sk-sy-0123456789abcdef")).toBe("sk-sy-0123");
  });

  it.each([
    ["Bearer sk-sy-abc", "sk-sy-abc"],
    ["bearer   sk-sy-abc", "sk-sy-abc"],
    ["Bearer", undefined],
    ["Basic dXNlcjpwYXNz", undefined],
    ["sk-sy-abc", undefined],
    ["Bearer a b", undefined],
    [undefined, undefined],
  ])("parseBearer(%j) → %j", (header, expected) => {
    expect(parseBearer(header)).toBe(expected);
  });
});
