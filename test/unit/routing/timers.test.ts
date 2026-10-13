import { describe, expect, it } from "vitest";
import { systemTimers } from "../../../src/modules/routing/timers.js";

describe("systemTimers", () => {
  it("sleep resolves, and rejects with the abort reason", async () => {
    const live = new AbortController();
    await expect(systemTimers.sleep(0, live.signal)).resolves.toBeUndefined();
    await expect(systemTimers.sleep(1, live.signal)).resolves.toBeUndefined();

    const aborted = new AbortController();
    aborted.abort(new Error("gone"));
    await expect(systemTimers.sleep(10, aborted.signal)).rejects.toThrow("gone");

    const later = new AbortController();
    const pending = systemTimers.sleep(60_000, later.signal);
    later.abort(new Error("client closed"));
    await expect(pending).rejects.toThrow("client closed");
  });

  it("deadline aborts with a TimeoutError and reports what is left", async () => {
    const deadline = systemTimers.deadline(1);
    expect(deadline.remaining()).toBeLessThanOrEqual(1);
    await new Promise((resolve) => deadline.signal.addEventListener("abort", resolve));
    expect((deadline.signal.reason as Error).name).toBe("TimeoutError");
    expect(deadline.remaining()).toBe(0);
  });

  it("a cleared deadline never fires", () => {
    const deadline = systemTimers.deadline(60_000);
    deadline.clear();
    expect(deadline.signal.aborted).toBe(false);
    expect(systemTimers.now()).toBeGreaterThan(0);
  });
});
