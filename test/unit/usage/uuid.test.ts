import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/core/uuid.js";

describe("uuidv7 (RFC 9562)", () => {
  it("encodes the millisecond timestamp, version 7 and the RFC variant", () => {
    const id = uuidv7(0x0189_0a5d_ac96, () => new Uint8Array(10).fill(0xff));
    expect(id).toMatch(/^01890a5d-ac96-7fff-bfff-ffffffffffff$/);
  });

  it("uses random bits after the timestamp", () => {
    const id = uuidv7(0, () => new Uint8Array(10));
    expect(id).toBe("00000000-0000-7000-8000-000000000000");
  });

  it("produces unique ids that sort by creation time", () => {
    const ids = [uuidv7(1_000), uuidv7(2_000), uuidv7(3_000)];
    expect([...ids].sort()).toEqual(ids);
    const many = new Set(Array.from({ length: 1_000 }, () => uuidv7()));
    expect(many.size).toBe(1_000);
  });
});
