import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LoadedConfig } from "../../config/load.js";
import { modelNotAllowed, modelNotFound } from "../../core/errors.js";
import type { TokenCounts } from "../../core/pricing.js";
import type { ChatProvider } from "../../core/provider.js";
import type { UsageOperation } from "../../core/usage.js";
import { type AuthenticateOptions, createAuthenticate } from "../auth/authenticate.js";
import { isModelAllowed } from "../auth/models.js";
import type { BudgetCheck } from "../budgets/check.js";
import type { ConfigRuntime, ConfigSnapshot } from "../config/runtime.js";
import { docs } from "../docs.js";
import { restoreChatResponse } from "../pii/restore.js";
import { createPiiStage, type PiiStage } from "../pii/stage.js";
import type { Admission, AdmissionService } from "../ratelimit/admission.js";
import {
  estimateChatTokenCounts,
  estimateChatTokens,
  estimateEmbeddingTokens,
} from "../ratelimit/estimate.js";
import { listModels } from "../routing/models.js";
import { type Candidate, planRoute, type RoutePlan } from "../routing/resolve.js";
import {
  type OutcomeHook,
  type OutcomeTracker,
  registerOutcomeFallback,
  type TokenUsage,
} from "../usage/outcome.js";
import { type RoutingDeps, runAttempts, type Served } from "./attempts.js";
import { registerMessagesRoute } from "./messages.js";
import { parseChatRequest, parseEmbeddingsRequest } from "./schema.js";
import { streamChat } from "./stream.js";
import type { UpstreamOutcome } from "./telemetry.js";
import { estimateChatUsage } from "./usage.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Config and providers this request runs with, fixed at its start (spec 008 hot reload). */
    snapshot?: ConfigSnapshot;
  }
}

export interface ProxyRoutesOptions {
  /** The live config; each request reads it once (spec 008, AC-12). */
  runtime: Pick<ConfigRuntime, "current">;
  auth: AuthenticateOptions;
  admission: AdmissionService;
  /** Monthly budgets (spec 007), checked before rate limiting. */
  budgets: BudgetCheck;
  /** Request-outcome hook (spec 006): one usage event per admitted request. */
  outcomes: OutcomeHook;
  /** Breakers, latency, clock and prices for routing (spec 008). */
  routing: RoutingDeps;
  /** Gateway start time in seconds, reported as `created` in /v1/models. */
  startedAt: number;
}

/** One routed call: the attempt loop for a planned request (spec 008). */
export interface AttemptOptions<T> {
  stream: boolean;
  operation?: "chat" | "embeddings";
  /** Token estimate for `lowest-cost`. */
  estimate?: TokenCounts | undefined;
  /** Aborts when the client disconnects. */
  signal: AbortSignal;
  call(provider: ChatProvider, candidate: Candidate, ctx: { signal: AbortSignal }): Promise<T>;
  describe?: ((value: T) => UpstreamOutcome) | undefined;
}

export type AttemptFn = <T>(
  request: FastifyRequest,
  reply: FastifyReply,
  plan: RoutePlan,
  options: AttemptOptions<T>,
) => Promise<Served<T>>;

export async function proxyRoutes(app: FastifyInstance, opts: ProxyRoutesOptions): Promise<void> {
  // In-flight requests finish with the config they started with (spec 008, AC-12).
  app.addHook("onRequest", async (request) => {
    request.snapshot = opts.runtime.current();
  });
  // Every /v1 route requires a valid key (spec 004); health routes live outside this plugin.
  app.addHook("onRequest", createAuthenticate(opts.auth));

  const snapshot = (request: FastifyRequest) => request.snapshot ?? opts.runtime.current();
  const allowedModels = (request: FastifyRequest) => request.principal?.allowedModels ?? null;
  // PII mask/block (spec 010): after admission, before the cache and any provider. One stage per
  // config version, so a reloaded `pii` section applies to new requests.
  const piiStages = new WeakMap<LoadedConfig, PiiStage>();
  const pii = (request: FastifyRequest): PiiStage => {
    const { config } = snapshot(request);
    let stage = piiStages.get(config);
    if (!stage) {
      stage = createPiiStage(config.pii);
      piiStages.set(config, stage);
    }
    return stage;
  };

  /**
   * Resolves the model to its candidates and keeps those the key may use (spec 008, AC-1: the
   * spec 004 rule per candidate). 404 for unknown models, 403 when no candidate is allowed.
   */
  function route(model: string, request: FastifyRequest): RoutePlan {
    const plan = planRoute(model, snapshot(request).config);
    if (!plan) throw modelNotFound(model);
    const allowed = allowedModels(request);
    const candidates = plan.candidates.filter((c) => isModelAllowed(allowed, model, c.ref));
    if (candidates.length === 0) throw modelNotAllowed(model);
    return { ...plan, candidates };
  }

  /**
   * Runs the attempt loop (spec 008). Before every attempt the response headers and the usage
   * event name the candidate and the attempt count (AC-10): the served one on success, the last
   * one tried on error, none (attempts 0) when no attempt was made.
   */
  const attempt: AttemptFn = (request, reply, plan, options) => {
    const { config, providers } = snapshot(request);
    return runAttempts({
      plan,
      providers,
      settings: { retry: config.retry, totalMs: config.server.timeouts.totalMs },
      deps: opts.routing,
      signal: options.signal,
      estimate: options.estimate,
      telemetry: {
        logger: request.log,
        stream: options.stream,
        principal: request.principal,
        ...(options.operation && { operation: options.operation }),
      },
      call: options.call,
      describe: options.describe,
      report(candidate, attempts) {
        reply.header("x-switchyard-attempts", attempts);
        if (candidate) {
          reply.header("x-switchyard-provider", candidate.provider);
          reply.header("x-switchyard-model", candidate.model);
        }
        request.outcome?.set({
          provider: candidate?.provider ?? null,
          servedModel: candidate?.model ?? null,
          attempts,
        });
      },
    });
  };

  /**
   * Rate-limit admission (spec 005); sets x-ratelimit-* headers or throws 429/400/503.
   * An admitted request starts its outcome tracker (spec 006): from here on it yields one event.
   * `resolved` is the first candidate; the attempt loop reports the one actually used.
   */
  async function admit(
    request: FastifyRequest,
    reply: FastifyReply,
    estimate: number,
    usage: {
      operation: UsageOperation;
      stream: boolean;
      model: string;
      resolved: { provider: string; model: string };
    },
  ) {
    if (!request.principal) return undefined;
    // Spec 007: budgets first, so an exhausted budget debits no rate-limit unit (AC-6).
    const budget = await opts.budgets.check(request.principal);
    reply.headers(budget.headers);
    const admission = await opts.admission.admit(request.principal, estimate);
    reply.headers(admission.headers);
    opts.outcomes.begin(request, {
      requestId: request.id,
      principal: request.principal,
      operation: usage.operation,
      stream: usage.stream,
      requestedModel: usage.model,
      provider: usage.resolved.provider,
      servedModel: usage.resolved.model,
      elapsedMs: () => reply.elapsedTime,
    });
    return admission;
  }

  // Records any admitted request whose route did not end its tracker (spec 006).
  registerOutcomeFallback(app);

  // Spec 007, AC-3: non-streaming responses carry their known cost (streams end after headers).
  app.addHook("onSend", async (request, reply, payload) => {
    const event = request.outcome?.event;
    if (event && !event.stream && event.costUsd !== null) {
      reply.header("x-switchyard-cost-usd", event.costUsd);
    }
    return payload;
  });

  app.get("/v1/models", { schema: docs.models }, async (request) => {
    const { config } = snapshot(request);
    const list = listModels(config, opts.startedAt);
    const allowed = allowedModels(request);
    if (!allowed || allowed.length === 0) return list;
    // An alias is listed when any of its candidates is allowed (spec 008, AC-1).
    const data = list.data.filter((m) =>
      planRoute(m.id, config)?.candidates.some((c) => isModelAllowed(allowed, m.id, c.ref)),
    );
    return { ...list, data };
  });

  app.post("/v1/chat/completions", { schema: docs.chatCompletions }, async (request, reply) => {
    const body = parseChatRequest(request.body);
    const plan = route(body.model, request);
    const stream = body.stream === true;
    const reserve = snapshot(request).config.limits.completionReserveTokens;
    const admission = await admit(request, reply, estimateChatTokens(body, reserve), {
      operation: "chat",
      stream,
      model: body.model,
      resolved: plan.candidates[0] as Candidate,
    });
    const masked = await pii(request).chat({ request, reply, admission, stream }, body);
    const estimate = estimateChatTokenCounts(body, reserve);

    if (stream) {
      return streamChat({
        reply,
        request: masked.body,
        admission,
        outcome: request.outcome,
        attempt: (call, signal) =>
          attempt(request, reply, plan, { stream: true, estimate, signal, call }),
        restore: masked.stream,
      });
    }

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const served = await settle(
        { admission, outcome: request.outcome, signal },
        attempt(request, reply, plan, {
          stream: false,
          estimate,
          signal,
          call: (provider, candidate, ctx) =>
            provider.chat({ ...masked.body, model: candidate.model }, ctx),
          describe: (result) => result,
        }),
        (s) => s.value.usage,
        (s) => estimateChatUsage(masked.body, s.value.body),
      );
      return restoreChatResponse(served.value.body, masked.restore);
    } finally {
      reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
    }
  });

  app.post("/v1/embeddings", { schema: docs.embeddings }, async (request, reply) => {
    const body = parseEmbeddingsRequest(request.body);
    const plan = route(body.model, request);
    const inputEstimate = estimateEmbeddingTokens(body.input);
    const admission = await admit(request, reply, inputEstimate, {
      operation: "embeddings",
      stream: false,
      model: body.model,
      resolved: plan.candidates[0] as Candidate,
    });
    const masked = await pii(request).embeddings({ request, reply, admission }, body);

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const served = await settle(
        { admission, outcome: request.outcome, signal },
        attempt(request, reply, plan, {
          stream: false,
          operation: "embeddings",
          estimate: { inputTokens: inputEstimate, outputTokens: 0 },
          signal,
          call: (provider, candidate, ctx) =>
            provider.embeddings({ ...masked.body, model: candidate.model }, ctx),
          describe: (result) => result,
        }),
        (s) => s.value.usage && { inputTokens: s.value.usage.inputTokens, outputTokens: 0 },
        () => ({ inputTokens: inputEstimate, outputTokens: 0 }),
      );
      return served.value.body;
    } finally {
      reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
    }
  });

  // Anthropic Messages API (spec 014): same routing, admission and streaming steps.
  registerMessagesRoute(app, {
    snapshot,
    route,
    attempt,
    admit,
    settle,
    abortOnClientDisconnect,
    pii,
  });
}

/**
 * Settles a non-streaming call. Reconciles the token reservation (spec 005, AC-6): real usage on
 * success (the reservation is kept when the provider reports none), a full refund on failure.
 * Ends the outcome tracker (spec 006): success with provider usage (else the estimate), a client
 * disconnect (499, nothing generated) or the error sent to the client.
 */
async function settle<T>(
  ctx: {
    admission: Admission | undefined;
    outcome: OutcomeTracker | undefined;
    signal: AbortSignal;
  },
  call: Promise<T>,
  reported: (result: T) => TokenUsage | undefined,
  estimate: (result: T) => TokenUsage,
): Promise<T> {
  const { admission, outcome } = ctx;
  try {
    const result = await call;
    const usage = reported(result);
    await admission?.reconcile(
      usage ? usage.inputTokens + usage.outputTokens : admission.reservedTokens,
    );
    outcome?.succeed(usage ? { usage } : { usage: estimate(result), estimated: true });
    return result;
  } catch (error) {
    await admission?.reconcile(undefined);
    if (ctx.signal.aborted) outcome?.clientClosed({ headersSent: false });
    else outcome?.fail(error);
    throw error;
  }
}

/** Aborts the upstream call if the client goes away before we respond. */
function abortOnClientDisconnect(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
