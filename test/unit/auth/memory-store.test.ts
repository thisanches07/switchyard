import { describe, expect, it } from "vitest";
import { GatewayError } from "../../../src/core/errors.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";

describe("MemoryKeyStore (test double for KeyStore)", () => {
  it("rejects duplicate team names with 409", async () => {
    const store = new MemoryKeyStore();
    await store.createTeam("a");
    await expect(store.createTeam("a")).rejects.toBeInstanceOf(GatewayError);
  });

  it("revokes idempotently and never exposes hashes", async () => {
    const store = new MemoryKeyStore();
    const { record } = await store.issueKey();
    const first = await store.revokeKey(record.id);
    const second = await store.revokeKey(record.id);
    expect(first?.status).toBe("revoked");
    expect(second?.revokedAt).toEqual(first?.revokedAt);
    expect(Object.keys((await store.listKeys())[0] ?? {})).not.toContain("hash");
    expect(await store.revokeKey("missing")).toBeUndefined();
  });
});
