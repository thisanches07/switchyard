import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../../src/core/auth.js";
import { GatewayError } from "../../../src/core/errors.js";
import type { RateLimiter } from "../../../src/core/ratelimit.js";
import { createLogger } from "../../../src/infra/logger.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { createAdmission } from "../../../src/modules/ratelimit/admission.js";
import { captureLogs } from "../../helpers/log-capture.js";
import { installTestMetrics } from "../../helpers/metrics.js";

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  keyId: "k1",
  teamId: "t1",
  allowedModels: null,
  keyLimits: { rpm: 2, tpm: 1_000 },
  teamLimits: { rpm: null, tpm: null },
  ...overrides,
});

const config = {
  defaults: {},
  onRedisError: "open" as const,
};

async function gatewayError(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error("expected GatewayError");
}

describe("admission", () => {
  let meters: ReturnType<typeof installTestMetrics>;
  beforeAll(() => {
    meters = installTestMetrics();
  });
  afterAll(async () => {
    await meters.uninstall();
  });

  function setup(
    limiter: RateLimiter = new MemoryRateLimiter(),
    onRedisError: "open" | "closed" = "open",
  ) {
    const logs = captureLogs();
    const logger = createLogger({ level: "info", destination: logs.stream });
    const admission = createAdmission({ limiter, config: { ...config, onRedisError }, logger });
    return { admission, logs: logs.lines, limiter };
  }

  it("admits within limits and returns x-ratelimit headers", async () => {
    const { admission } = setup();
    const admitted = await admission.admit(principal(), 100);
    expect(admitted.headers).toMatchObject({
      "x-ratelimit-limit-requests": "2",
      "x-ratelimit-remaining-requests": "1",
      "x-ratelimit-limit-tokens": "1000",
      "x-ratelimit-remaining-tokens": "900",
    });
    expect(admitted.reservedTokens).toBe(100);
  });

  it("rejects with 429 type requests, retry-after and headers once the key is out of requests", async () => {
    const { admission } = setup();
    await admission.admit(principal(), 1);
    await admission.admit(principal(), 1);
    const error = await gatewayError(admission.admit(principal(), 1));
    expect(error.status).toBe(429);
    expect(error.type).toBe("requests");
    expect(error.code).toBe("rate_limit_exceeded");
    expect(error.message).toContain("key");
    expect(Number(error.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(error.headers["x-ratelimit-remaining-requests"]).toBe("0");
  });

  it("rejects with type tokens when the token bucket cannot cover the estimate", async () => {
    const { admission } = setup();
    await admission.admit(principal({ keyLimits: { rpm: null, tpm: 1_000 } }), 800);
    const error = await gatewayError(
      admission.admit(principal({ keyLimits: { rpm: null, tpm: 1_000 } }), 300),
    );
    expect(error.type).toBe("tokens");
  });

  it("names the team scope when the team cap is what blocks", async () => {
    const { admission } = setup();
    const teamCapped = principal({
      keyLimits: { rpm: 100, tpm: null },
      teamLimits: { rpm: 1, tpm: null },
    });
    await admission.admit(teamCapped, 1);
    const error = await gatewayError(admission.admit(teamCapped, 1));
    expect(error.message).toContain("team");
  });

  it("returns 400 for a request that can never fit", async () => {
    const { admission } = setup();
    const error = await gatewayError(admission.admit(principal(), 5_000));
    expect(error.status).toBe(400);
    expect(error.code).toBe("request_too_large_for_limit");
  });

  it("does nothing and sends no headers when nothing is limited", async () => {
    const { admission } = setup();
    const admitted = await admission.admit(
      principal({ keyLimits: { rpm: null, tpm: null } }),
      10_000,
    );
    expect(admitted.headers).toEqual({});
    await admitted.reconcile(5);
  });

  // A frozen clock: wall-clock refill during a slow run must not move the levels asserted below.
  it("reconcile refunds unused tokens and charges overruns", async () => {
    const limiter = new MemoryRateLimiter({ now: () => 0 });
    const { admission } = setup(limiter);
    const p = principal({ keyLimits: { rpm: null, tpm: 1_000 } });

    const first = await admission.admit(p, 600);
    await first.reconcile(100);
    expect(await limiter.peek("sy:rl:key:k1:tok", 1_000)).toBe(900);

    const second = await admission.admit(p, 100);
    await second.reconcile(1_200);
    expect(await limiter.peek("sy:rl:key:k1:tok", 1_000)).toBeLessThan(0);
  });

  it("reconcile with undefined refunds the whole reservation", async () => {
    const limiter = new MemoryRateLimiter({ now: () => 0 });
    const { admission } = setup(limiter);
    const admitted = await admission.admit(
      principal({ keyLimits: { rpm: null, tpm: 1_000 } }),
      400,
    );
    await admitted.reconcile(undefined);
    expect(await limiter.peek("sy:rl:key:k1:tok", 1_000)).toBe(1_000);
  });

  const broken: RateLimiter = {
    take: async () => {
      throw new Error("ECONNREFUSED");
    },
    adjust: async () => {
      throw new Error("ECONNREFUSED");
    },
    peek: async () => {
      throw new Error("ECONNREFUSED");
    },
  };

  it("fails open: admits, counts it and warns at most once per minute", async () => {
    const { admission, logs } = setup(broken, "open");
    const admitted = await admission.admit(principal(), 1);
    await admission.admit(principal(), 1);
    expect(admitted.headers).toEqual({});
    await admitted.reconcile(1); // must not throw
    expect(
      logs.filter((l) => l.msg === "rate limiter unavailable, admitting requests"),
    ).toHaveLength(1);
    const points = await meters.points("switchyard_ratelimit_fail_open_total");
    expect(points[0]?.value).toBeGreaterThanOrEqual(2);
  });

  it("fails closed with 503 when configured", async () => {
    const { admission } = setup(broken, "closed");
    const error = await gatewayError(admission.admit(principal(), 1));
    expect(error.status).toBe(503);
    expect(error.code).toBe("rate_limiter_unavailable");
  });

  it("counts rejections by scope and kind", async () => {
    const { admission } = setup();
    const p = principal({ keyId: "counted", keyLimits: { rpm: 1, tpm: null } });
    await admission.admit(p, 1);
    await admission.admit(p, 1).catch(() => undefined);
    const points = await meters.points("switchyard_ratelimit_rejections_total");
    expect(points.map((pt) => pt.attributes)).toContainEqual({ scope: "key", kind: "requests" });
  });
});
