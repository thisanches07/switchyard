import type { Span } from "@opentelemetry/api";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LoadedConfig } from "../../config/load.js";
import type { ChatRequest } from "../../core/chat.js";
import { invalidRequest } from "../../core/errors.js";
import type { ChatProvider, ChatResult } from "../../core/provider.js";
import type { UsageOperation } from "../../core/usage.js";
import { anthropicRateLimitHeaders } from "../anthropic/inbound-errors.js";
import { fromAnthropicRequest } from "../anthropic/inbound-request.js";
import { toAnthropicMessage, withRequestedModel } from "../anthropic/inbound-response.js";
import { createAnthropicEncoder } from "../anthropic/inbound-stream.js";
import { parseMessagesRequest } from "../anthropic/schema.js";
import { docs } from "../docs.js";
import type { Admission } from "../ratelimit/admission.js";
import { estimateChatTokens } from "../ratelimit/estimate.js";
import type { ResolvedModel } from "../routing/resolve.js";
import type { OutcomeTracker, TokenUsage } from "../usage/outcome.js";
import { streamChat } from "./stream.js";
import { tracedUpstreamCall } from "./telemetry.js";
import { estimateChatUsage, estimateTokens, messageChars } from "./usage.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** `anthropic`: errors on this route use the Anthropic shape (ADR-0016). */
    api?: "anthropic";
  }
}

/** Pipeline steps shared with `/v1/chat/completions` (defined in `routes.ts`). */
export interface MessagesRouteDeps {
  config: LoadedConfig;
  route(model: string, request: FastifyRequest, reply: FastifyReply): [ResolvedModel, ChatProvider];
  admit(
    request: FastifyRequest,
    reply: FastifyReply,
    estimate: number,
    usage: { operation: UsageOperation; stream: boolean; model: string; resolved: ResolvedModel },
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
}

/**
 * `POST /v1/messages` (spec 014): the Anthropic Messages API, translated to the canonical request
 * and served by the same pipeline as chat (auth, routing, admission, upstream span, streaming).
 */
export function registerMessagesRoute(app: FastifyInstance, deps: MessagesRouteDeps): void {
  app.post(
    "/v1/messages",
    { schema: docs.messages, config: { api: "anthropic" } },
    async (request, reply) => {
      reply.header("request-id", request.id);
      tagMessagesSpan(request);
      const body = parseMessagesRequest(request.body);
      const [resolved, provider] = deps.route(body.model, request, reply);
      const sameFamily = provider.type === "anthropic";

      const beta = request.headers["anthropic-beta"];
      const { request: canonical, blockers } = fromAnthropicRequest(body, {
        beta: sameFamily && typeof beta === "string" ? beta : undefined,
      });
      if (!sameFamily && blockers.length > 0) {
        throw invalidRequest(
          `${blockers.join(", ")}: not supported when the model is served by a non-Anthropic provider ("${resolved.provider}")`,
        );
      }
      // Spread keeps the Anthropic extension (a symbol key) for the adapter.
      const upstreamRequest: ChatRequest = { ...canonical, model: resolved.model };
      const stream = body.stream === true;
      const admission = await deps.admit(
        request,
        reply,
        estimateChatTokens(canonical, deps.config.limits.completionReserveTokens),
        { operation: "messages", stream, model: body.model, resolved },
      );
      reply.headers(anthropicRateLimitHeaders(admission?.headers ?? {}, Date.now()));

      if (stream) {
        return streamChat({
          reply,
          provider,
          request: upstreamRequest,
          logger: request.log,
          principal: request.principal,
          admission,
          outcome: request.outcome,
          encoder: createAnthropicEncoder({
            model: body.model,
            stopSequences: body.stop_sequences,
            inputTokens: estimateTokens(messageChars(canonical)),
          }),
        });
      }

      const signal = deps.abortOnClientDisconnect(reply);
      const started = performance.now();
      let result: ChatResult;
      try {
        result = await deps.settle(
          { admission, outcome: request.outcome, signal },
          tracedUpstreamCall(
            { provider, model: resolved.model, logger: request.log, principal: request.principal },
            () => provider.chat(upstreamRequest, { signal }),
          ),
          (r) => r.usage,
          (r) => estimateChatUsage(upstreamRequest, r.body),
        );
      } finally {
        reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
      }
      if (result.native !== undefined) return withRequestedModel(result.native, body.model);
      return toAnthropicMessage(result.body, {
        model: body.model,
        provider: provider.name,
        stopSequences: body.stop_sequences,
      });
    },
  );
}

/** Request-span attributes for the Anthropic surface (spec 014, AC-9). No content. */
function tagMessagesSpan(request: FastifyRequest): void {
  const span: Span | null | undefined =
    typeof request.opentelemetry === "function" ? request.opentelemetry().span : undefined;
  span?.setAttributes({ "gen_ai.operation.name": "chat", "switchyard.api": "anthropic" });
}
