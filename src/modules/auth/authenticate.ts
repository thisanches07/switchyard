import type { FastifyRequest } from "fastify";
import type { AuthRecord, KeyStore, Principal } from "../../core/auth.js";
import { invalidApiKey, rateLimited } from "../../core/errors.js";
import type { RateLimiter } from "../../core/ratelimit.js";
import { retryAfterSeconds } from "../ratelimit/headers.js";
import { bucketKey } from "../ratelimit/plan.js";
import type { AuthCache } from "./cache.js";
import { extractApiKey, hashKey, KEY_PREFIX } from "./keys.js";
import { tagRequestSpan } from "./telemetry.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook on authenticated `/v1` requests (spec 004). */
    principal?: Principal;
  }
}

export type AuthFailureReason = "missing" | "malformed" | "unknown" | "revoked" | "expired";

export interface AuthenticateOptions {
  store: KeyStore;
  pepper: string;
  cache: AuthCache<AuthRecord>;
  now?: () => Date;
  onFailure?: (reason: AuthFailureReason) => void;
  /** Throttles missing/malformed/unknown keys per client address (spec 005, AC-11). */
  failureLimit?: {
    limiter: RateLimiter;
    perMinute: number;
    onRejected?: () => void;
  };
}

/** Failures that cost nothing to fake, so they are throttled per address. */
const THROTTLED: ReadonlySet<AuthFailureReason> = new Set(["missing", "malformed", "unknown"]);

/**
 * `onRequest` hook for `/v1/*` (spec 004, AC-3/AC-4): resolves the bearer key to a principal
 * or rejects with 401 before any provider is called.
 */
export function createAuthenticate(options: AuthenticateOptions) {
  const now = options.now ?? (() => new Date());
  const limit = options.failureLimit;

  const tooManyFailures = (retryAfterMs: number) => {
    limit?.onRejected?.();
    return rateLimited("requests", "ip", limit?.perMinute ?? 0, {
      "retry-after": String(retryAfterSeconds(retryAfterMs)),
    });
  };

  /** Counts a failure for the address; turns it into a 429 when the address is out of attempts. */
  const reject = async (request: FastifyRequest, reason: AuthFailureReason) => {
    options.onFailure?.(reason);
    if (limit && THROTTLED.has(reason)) {
      try {
        const result = await limit.limiter.take([
          { key: bucketKey("ip", request.ip, "requests"), capacity: limit.perMinute, cost: 1 },
        ]);
        if (!result.allowed) return tooManyFailures(result.retryAfterMs);
      } catch {
        // Limiter down: fall back to a plain 401 (this protection fails open).
      }
    }
    return invalidApiKey();
  };

  /** Refuses lookups from an address that already used up its failures, before the database. */
  const ensureAddressMayLookUp = async (request: FastifyRequest) => {
    if (!limit) return;
    let available: number;
    try {
      available = await limit.limiter.peek(
        bucketKey("ip", request.ip, "requests"),
        limit.perMinute,
      );
    } catch {
      return; // Limiter down: allow the lookup.
    }
    if (available < 1) throw tooManyFailures(((1 - available) * 60_000) / limit.perMinute);
  };

  return async function authenticate(request: FastifyRequest): Promise<void> {
    const extracted = extractApiKey(request.headers);
    if ("reason" in extracted) throw await reject(request, extracted.reason);
    const { token } = extracted;
    if (!token.startsWith(KEY_PREFIX)) throw await reject(request, "malformed");

    const hash = hashKey(options.pepper, token);
    let record = options.cache.get(hash);
    if (!record) {
      await ensureAddressMayLookUp(request);
      record = await options.store.findKeyByHash(hash);
      if (!record) throw await reject(request, "unknown");
      options.cache.set(hash, record);
    }

    const { key, team } = record;
    if (key.status !== "active") throw await reject(request, "revoked");
    if (key.expiresAt && key.expiresAt.getTime() <= now().getTime()) {
      throw await reject(request, "expired");
    }

    request.principal = {
      keyId: key.id,
      teamId: key.teamId,
      allowedModels: key.allowedModels,
      keyLimits: { rpm: key.rpm, tpm: key.tpm },
      teamLimits: { rpm: team.rpm, tpm: team.tpm },
      piiMode: key.piiMode,
    };
    request.log = request.log.child({ teamId: key.teamId, keyId: key.id });
    tagRequestSpan(request);
  };
}
