import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config/schema.js";
import type { Principal } from "../../core/auth.js";
import type { ChatRequest, EmbeddingsRequest } from "../../core/chat.js";
import { piiDetected } from "../../core/errors.js";
import { PII_TYPES, type PiiMode, type PiiRequestResult } from "../../core/pii.js";
import type { Admission } from "../ratelimit/admission.js";
import { type MaskResult, maskChatRequest, maskEmbeddingsRequest } from "./mask.js";
import type { RestoreMap } from "./placeholder.js";
import { createScanner, type Scanner } from "./scan.js";
import { recordPiiScan } from "./telemetry.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * What the PII stage did (spec 010): mode, action and counts per type, never values. Set on
     * every admitted chat and embeddings request; read by the request-outcome hook (spec 006).
     */
    pii?: PiiRequestResult;
  }
}

export const PII_HEADER = "x-switchyard-pii";

export interface PiiStageContext {
  request: FastifyRequest;
  reply: FastifyReply;
  /** Refunded in full when the request is blocked (spec 005 AC-6 semantics). */
  admission?: Admission | undefined;
  /** Streamed answers keep their placeholders (restore in streams is spec 015). */
  stream?: boolean;
}

export interface PiiStageResult<T> {
  /** The request to send upstream: masked, or the original when nothing was replaced. */
  body: T;
  /** Placeholder → original value. Keep it in a local variable: never log, cache or attach it. */
  restore: RestoreMap;
}

const NOTHING: RestoreMap = new Map();
const OFF: PiiRequestResult = { mode: "off", action: "none", detections: {} };

/**
 * PII stage (spec 010): runs after authentication, model authorization and rate-limit admission,
 * before the cache (spec 009) and any provider call.
 */
export function createPiiStage(config: AppConfig["pii"]) {
  const scan = createScanner({ types: config.detectors, denyList: config.denyList });

  /** Effective mode: the key's own, else `pii.defaultMode`. */
  const modeFor = (principal: Principal | undefined): PiiMode =>
    principal?.piiMode ?? config.defaultMode;

  async function run<T>(
    ctx: PiiStageContext,
    body: T,
    mask: (body: T, scan: Scanner) => MaskResult<T>,
  ): Promise<PiiStageResult<T>> {
    const mode = modeFor(ctx.request.principal);
    if (mode === "off") {
      ctx.request.pii = OFF;
      return { body, restore: NOTHING };
    }

    const masked = mask(body, scan);
    const found = PII_TYPES.filter((type) => (masked.detections[type] ?? 0) > 0);
    const action = found.length === 0 ? "none" : mode === "block" ? "blocked" : "masked";
    const result: PiiRequestResult = {
      mode,
      action,
      detections: masked.detections,
      ...(masked.uninspected && { uninspected: true }),
    };
    ctx.request.pii = result;
    recordPiiScan(ctx.request, result);
    // Usage event (spec 006 outcome hook): counts per type only; `{}` stays the default when off.
    ctx.request.outcome?.set({ piiDetections: { ...masked.detections } });

    if (action === "blocked") {
      // Nothing will be generated: give the tokens back, keep the request unit.
      await ctx.admission?.reconcile(undefined);
      const error = piiDetected(found, { [PII_HEADER]: "blocked" });
      // One `rejected` event: provider null, attempts 0 (spec 006 design §4).
      ctx.request.outcome?.reject(error);
      throw error;
    }
    if (action === "none") {
      ctx.reply.header(PII_HEADER, "none");
      return { body, restore: NOTHING };
    }
    ctx.reply.header(PII_HEADER, ctx.stream ? "masked-unrestored" : "masked");
    return { body: masked.request, restore: masked.restore };
  }

  return {
    chat: (ctx: PiiStageContext, body: ChatRequest) => run(ctx, body, maskChatRequest),
    embeddings: (ctx: PiiStageContext, body: EmbeddingsRequest) =>
      run(ctx, body, maskEmbeddingsRequest),
  };
}

export type PiiStage = ReturnType<typeof createPiiStage>;
