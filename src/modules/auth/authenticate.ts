import type { FastifyRequest } from "fastify";
import type { ApiKeyRecord, KeyStore, Principal } from "../../core/auth.js";
import { invalidApiKey } from "../../core/errors.js";
import type { AuthCache } from "./cache.js";
import { hashKey, KEY_PREFIX, parseBearer } from "./keys.js";

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
  cache: AuthCache<ApiKeyRecord>;
  now?: () => Date;
  onFailure?: (reason: AuthFailureReason) => void;
}

/**
 * `onRequest` hook for `/v1/*` (spec 004, AC-3/AC-4): resolves the bearer key to a principal
 * or rejects with 401 before any provider is called.
 */
export function createAuthenticate(options: AuthenticateOptions) {
  const now = options.now ?? (() => new Date());

  const reject = (reason: AuthFailureReason) => {
    options.onFailure?.(reason);
    return invalidApiKey();
  };

  return async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header) throw reject("missing");
    const token = parseBearer(header);
    if (!token?.startsWith(KEY_PREFIX)) throw reject("malformed");

    const hash = hashKey(options.pepper, token);
    let record = options.cache.get(hash);
    if (!record) {
      record = await options.store.findKeyByHash(hash);
      if (!record) throw reject("unknown");
      options.cache.set(hash, record);
    }
    if (record.status !== "active") throw reject("revoked");
    if (record.expiresAt && record.expiresAt.getTime() <= now().getTime()) {
      throw reject("expired");
    }

    request.principal = {
      keyId: record.id,
      teamId: record.teamId,
      allowedModels: record.allowedModels,
    };
    request.log = request.log.child({ teamId: record.teamId, keyId: record.id });
  };
}
