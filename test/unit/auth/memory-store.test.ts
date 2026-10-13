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

  it("stores the PII mode (null by default) and patches it without touching limits", async () => {
    const store = new MemoryKeyStore();
    const { record } = await store.issueKey({ limits: { rpm: 5 } });
    expect(record.piiMode).toBeNull();
    const { record: masked } = await store.issueKey({ piiMode: "mask" });
    expect(masked.piiMode).toBe("mask");

    expect(await store.updateKeyLimits(record.id, { piiMode: "block" })).toMatchObject({
      piiMode: "block",
      rpm: 5,
    });
    expect(await store.updateKeyLimits(record.id, { rpm: 7 })).toMatchObject({
      piiMode: "block",
      rpm: 7,
    });
    expect(await store.updateKeyLimits(record.id, { piiMode: null })).toMatchObject({
      piiMode: null,
    });
    const found = await store.findKeyByHash([...store.keys.values()][0]?.hash ?? "");
    expect(found?.key.piiMode).toBeNull();
  });
});
