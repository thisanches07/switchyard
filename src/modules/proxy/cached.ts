/**
 * Serves a cache hit (spec 009, AC-3, AC-7, AC-8, AC-9): no provider is called. The request was
 * admitted like any other; its token reservation is reconciled to the stored usage, its usage
 * event costs "0" with attempts 0, and the saving is counted at the stored candidate's price.
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ChatChunk, ChatRequest } from "../../core/chat.js";
import type { CostEstimator } from "../../core/pricing.js";
import { rechunk } from "../cache/chunks.js";
import { CACHE_HEADER } from "../cache/eligibility.js";
import type { CacheHit } from "../cache/stage.js";
import { recordSavings, tagCacheSpan } from "../cache/telemetry.js";
import type { RestoreMap } from "../pii/placeholder.js";
import { restoreChatResponse } from "../pii/restore.js";
import type { StreamRestore } from "../pii/stage.js";
import type { Admission } from "../ratelimit/admission.js";
import { splitModelRef } from "../routing/resolve.js";
import { includeUsage, openAiEncoder } from "./stream.js";
import { countCachedRequest } from "./telemetry.js";

export interface ServeCachedArgs {
  request: FastifyRequest;
  reply: FastifyReply;
  hit: CacheHit;
  /** The request as sent upstream (masked): `stream` and `stream_options` decide the format. */
  body: ChatRequest;
  admission: Admission | undefined;
  /** This request's placeholder map (spec 010); restoration happens after the cache (AC-11). */
  restore: RestoreMap;
  /** Masked streaming requests (spec 015): restores the re-chunked hit like a live stream. */
  streamRestore?: StreamRestore | undefined;
  clock: () => number;
  costEstimator?: CostEstimator | undefined;
}

/** Header value of a hit (the usage event spells it `semantic_hit`). */
const headerValue = (hit: CacheHit) => (hit.status === "hit" ? "hit" : "semantic-hit");

export async function serveCachedChat(args: ServeCachedArgs): Promise<unknown> {
  const { request, reply, hit, admission } = args;
  const stored = hit.response;
  const ref = splitModelRef(stored.candidate) ?? { provider: stored.candidate, model: "" };
  const teamId = request.principal?.teamId ?? "none";
  const usage = { inputTokens: stored.usage.inputTokens, outputTokens: stored.usage.outputTokens };

  reply
    .header(CACHE_HEADER, headerValue(hit))
    .header("x-switchyard-provider", ref.provider)
    .header("x-switchyard-model", ref.model)
    .header("x-switchyard-attempts", 0);
  request.outcome?.set({
    provider: ref.provider,
    servedModel: ref.model,
    attempts: 0,
    cacheStatus: hit.status,
    costUsd: "0",
  });
  tagCacheSpan(request, {
    result: hit.status,
    layer: hit.layer,
    ...(hit.similarity !== undefined && { similarity: hit.similarity }),
  });
  recordSavings(
    hit.layer,
    { model: stored.candidate, team: teamId },
    args.costEstimator?.estimateUsd(stored.candidate, {
      ...usage,
      ...(stored.usage.cachedInputTokens !== undefined && {
        cachedInputTokens: stored.usage.cachedInputTokens,
      }),
    }),
  );
  countCachedRequest({ provider: ref.provider, model: ref.model, team: teamId, cache: hit.status });

  // Spec 005 AC-6: the reservation becomes the stored usage (a hit still uses TPM, spec open Q1).
  await admission?.reconcile(usage.inputTokens + usage.outputTokens);
  request.outcome?.succeed({ usage, estimated: stored.estimated });

  const body = {
    ...stored.body,
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(args.clock() / 1_000),
  };
  if (args.body.stream !== true) return restoreChatResponse(body, args.restore);

  // Streamed hit (AC-7): the stored chunks go through the same PII restore as a live stream
  // (spec 015), so the client sees its own values and the cache keeps the placeholders.
  const encoder = openAiEncoder(includeUsage(args.body));
  const chunks = rechunk(body, usage);
  const session = args.streamRestore?.open(chunks[0]);
  async function* events(): AsyncGenerator<string> {
    if (!session) {
      for (const chunk of chunks) yield* encoder.chunk(chunk);
    } else {
      const iterator = chunks[Symbol.iterator]();
      const source: AsyncIterator<ChatChunk> = { next: async () => iterator.next() };
      for await (const step of session.steps(await source.next(), source)) {
        for (const chunk of step.out) yield* encoder.chunk(chunk);
      }
    }
    yield* encoder.end(usage);
  }
  reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("x-accel-buffering", "no");
  return reply.send(Readable.from(events()));
}
