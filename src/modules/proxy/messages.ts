import type { Span } from "@opentelemetry/api";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChatRequest } from "../../core/chat.js";
import { invalidRequest } from "../../core/errors.js";
import type { ChatProvider, ChatResult } from "../../core/provider.js";
import type { UsageOperation } from "../../core/usage.js";
import { anthropicRateLimitHeaders } from "../anthropic/inbound-errors.js";
import { fromAnthropicRequest } from "../anthropic/inbound-request.js";
import { toAnthropicMessage, withRequestedModel } from "../anthropic/inbound-response.js";
import { createAnthropicEncoder } from "../anthropic/inbound-stream.js";
import { parseMessagesRequest } from "../anthropic/schema.js";
import type { ConfigSnapshot } from "../config/runtime.js";
import { docs } from "../docs.js";
import { restoreAnthropicMessage, restoreChatResponse } from "../pii/restore.js";
import type { PiiStage } from "../pii/stage.js";
import type { Admission } from "../ratelimit/admission.js";
import { estimateChatTokenCounts, estimateChatTokens } from "../ratelimit/estimate.js";
import type { Candidate, RoutePlan } from "../routing/resolve.js";
import type { OutcomeTracker, TokenUsage } from "../usage/outcome.js";
import type { Served } from "./attempts.js";
import type { AttemptFn } from "./routes.js";
import { streamChat } from "./stream.js";
import { estimateChatUsage, estimateTokens, messageChars } from "./usage.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** `anthropic`: errors on this route use the Anthropic shape (ADR-0016). */
    api?: "anthropic";
  }
}

/** Pipeline steps shared with `/v1/chat/completions` (defined in `routes.ts`). */
export interface MessagesRouteDeps {
  /** Config and providers of this request, fixed at its start (spec 008 hot reload). */
  snapshot(request: FastifyRequest): ConfigSnapshot;
  /** Candidates of a model the key may use (404/403 otherwise, spec 008 AC-1). */
  route(model: string, request: FastifyRequest): RoutePlan;
  /** The attempt loop (spec 008). */
  attempt: AttemptFn;
  admit(
    request: FastifyRequest,
    reply: FastifyReply,
    estimate: number,
    usage: {
      operation: UsageOperation;
      stream: boolean;
      model: string;
      resolved: { provider: string; model: string };
    },
  ): Promise<Admission | undefined>;
  settle<T>(
    ctx: {
      admission: Admission | undefined;
      outcome: OutcomeTracker | undefined;
      signal: AbortSignal;
    },
    call: Promise<T>,
    reported: (result: T) => TokenUsage | undefined,
    estimate: (result: T) => TokenUsage,
  ): Promise<T>;
  abortOnClientDisconnect(reply: FastifyReply): AbortSignal;
  /** PII stage (spec 010) of the request's config, run on the canonical request after admission. */
  pii(request: FastifyRequest): PiiStage;
}

/**
 * `POST /v1/messages` (spec 014): the Anthropic Messages API, translated to the canonical request
 * and served by the same pipeline as chat (auth, routing, admission, attempts, streaming).
 */
export function registerMessagesRoute(app: FastifyInstance, deps: MessagesRouteDeps): void {
  app.post(
    "/v1/messages",
    { schema: docs.messages, config: { api: "anthropic" } },
    async (request, reply) => {
      reply.header("request-id", request.id);
      tagMessagesSpan(request);
      const body = parseMessagesRequest(request.body);
      const routed = deps.route(body.model, request);

      // The canonical request is built once. `anthropic-beta` rides in the Anthropic extension,
      // which only the `anthropic` adapter reads (same-family path, ADR-0016).
      const beta = request.headers["anthropic-beta"];
      const { request: canonical, blockers } = fromAnthropicRequest(body, {
        beta: typeof beta === "string" ? beta : undefined,
      });
      const { config, providers } = deps.snapshot(request);
      const plan = sameFamilyOnly(routed, blockers, providers);

      const stream = body.stream === true;
      const reserve = config.limits.completionReserveTokens;
      // One usage event per admitted request, operation "messages" (spec 006).
      const admission = await deps.admit(request, reply, estimateChatTokens(canonical, reserve), {
        operation: "messages",
        stream,
        model: body.model,
        resolved: plan.candidates[0] as Candidate,
      });
      reply.headers(anthropicRateLimitHeaders(admission?.headers ?? {}, Date.now()));
      // PII (spec 010) masks canonical text in place; spread keeps the Anthropic extension (a
      // symbol key), so the same-family adapter writes masked text back into the client's blocks.
      const masked = await deps.pii(request).chat({ request, reply, admission, stream }, canonical);
      const upstreamRequest: ChatRequest = masked.body;
      const estimate = estimateChatTokenCounts(canonical, reserve);

      if (stream) {
        return streamChat({
          reply,
          request: upstreamRequest,
          admission,
          outcome: request.outcome,
          attempt: (call, signal) =>
            deps.attempt(request, reply, plan, { stream: true, estimate, signal, call }),
          encoder: createAnthropicEncoder({
            model: body.model,
            stopSequences: body.stop_sequences,
            inputTokens: estimateTokens(messageChars(canonical)),
          }),
          // Spec 015: cross-family chunks are restored; native same-family events are not.
          restore: masked.stream,
        });
      }

      const signal = deps.abortOnClientDisconnect(reply);
      const started = performance.now();
      let served: Served<ChatResult>;
      try {
        served = await deps.settle(
          { admission, outcome: request.outcome, signal },
          deps.attempt(request, reply, plan, {
            stream: false,
            estimate,
            signal,
            call: (provider, candidate, ctx) =>
              provider.chat({ ...upstreamRequest, model: candidate.model }, ctx),
            describe: (result) => result,
          }),
          (s) => s.value.usage,
          (s) => estimateChatUsage(upstreamRequest, s.value.body),
        );
      } finally {
        reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
      }
      const result = served.value;
      if (result.native !== undefined) {
        return withRequestedModel(
          restoreAnthropicMessage(result.native, masked.restore),
          body.model,
        );
      }
      return toAnthropicMessage(restoreChatResponse(result.body, masked.restore), {
        model: body.model,
        provider: served.provider.name,
        stopSequences: body.stop_sequences,
      });
    },
  );
}

/**
 * Anthropic-only content (documents, server tools, …) can only go to `anthropic` candidates
 * (ADR-0016); with such content the others are dropped, and a 400 names the content when none
 * is left (spec 008 design §8).
 */
function sameFamilyOnly(
  plan: RoutePlan,
  blockers: readonly string[],
  providers: ReadonlyMap<string, ChatProvider>,
): RoutePlan {
  if (blockers.length === 0) return plan;
  const candidates = plan.candidates.filter((c) => providers.get(c.provider)?.type === "anthropic");
  if (candidates.length > 0) return { ...plan, candidates };
  throw invalidRequest(
    `${blockers.join(", ")}: not supported when the model is served by a non-Anthropic provider ("${plan.candidates[0]?.provider}")`,
  );
}

/** Request-span attributes for the Anthropic surface (spec 014, AC-9). No content. */
function tagMessagesSpan(request: FastifyRequest): void {
  const span: Span | null | undefined =
    typeof request.opentelemetry === "function" ? request.opentelemetry().span : undefined;
  span?.setAttributes({ "gen_ai.operation.name": "chat", "switchyard.api": "anthropic" });
}
