/**
 * The request-outcome hook (spec 006, AC-3): the single point where an admitted request's end is
 * recorded. Routes begin a tracker right after admission and call exactly one terminal method;
 * later specs add data with `set()` (008 attempts, 009 cacheStatus, 010 piiDetections) or end a
 * request with `reject()` (010), instead of adding completion paths. See design.md §4.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { GatewayError } from "../../core/errors.js";
import type {
  OutcomeRecorder,
  UsageEvent,
  UsageOperation,
  UsageOutcome,
} from "../../core/usage.js";
import { uuidv7 } from "../../core/uuid.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set once the request is admitted (spec 006); absent for requests rejected before. */
    outcome?: OutcomeTracker;
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported prompt-cache read tokens (part of inputTokens). */
  cachedInputTokens?: number | undefined;
}

/** Data later specs contribute while the request runs. */
export type OutcomeContribution = Partial<
  Pick<
    UsageEvent,
    | "provider"
    | "servedModel"
    | "attempts"
    | "cacheStatus"
    | "piiDetections"
    | "cachedInputTokens"
    | "costUsd"
  >
>;

export interface OutcomeInit {
  /** Same value as the x-switchyard-request-id header. */
  requestId: string;
  principal: { teamId: string; keyId: string };
  operation: UsageOperation;
  stream: boolean;
  /** The model the client sent. */
  requestedModel: string;
  /** Resolved provider and model; null when no upstream will be called. */
  provider: string | null;
  servedModel: string | null;
  /** Milliseconds since the request arrived (e.g. `() => reply.elapsedTime`). */
  elapsedMs: () => number;
}

export interface SuccessResult {
  usage?: TokenUsage | undefined;
  /** True when the usage was estimated (spec 003). */
  estimated?: boolean | undefined;
  /** Defaults to 200. */
  status?: number | undefined;
  ttfbMs?: number | undefined;
}

export interface PartialResult {
  usage?: TokenUsage | undefined;
  estimated?: boolean | undefined;
  ttfbMs?: number | undefined;
}

/** One per admitted request. The first terminal call wins; later ones are ignored. */
export interface OutcomeTracker {
  readonly done: boolean;
  /** The event handed to the recorder once the request ended (spec 007 reads its cost). */
  readonly event: UsageEvent | undefined;
  /** Adds or overrides fields of the event (spec 007–010 contributions). */
  set(fields: OutcomeContribution): void;
  /** The full response was delivered (for streams: before `[DONE]`). */
  succeed(result: SuccessResult): void;
  /** Failure before any response byte: status and code of the error sent to the client. */
  fail(error: unknown): void;
  /** Stream failure after the first chunk (ADR-0008): status 200, code of the SSE error event. */
  failMidstream(error: unknown, result: PartialResult): void;
  /** The client went away: status 200 when headers were already sent, else 499. */
  clientClosed(result: PartialResult & { headersSent: boolean }): void;
  /** Admitted, then refused by a gateway policy before any upstream call (e.g. PII block). */
  reject(error: GatewayError): void;
}

export interface OutcomeHook {
  /** Starts the tracker for an admitted request and attaches it as `request.outcome`. */
  begin(request: { outcome?: OutcomeTracker }, init: OutcomeInit): OutcomeTracker;
}

export interface OutcomeHookDeps {
  recorder: OutcomeRecorder;
  logger: FastifyBaseLogger;
  now?: () => number;
  /**
   * Cost of a request that called a provider (spec 007, AC-2): exact decimal string, or null when
   * unknown. With it, requests that made no upstream call cost exactly "0". Without it, costs stay
   * null unless a contribution sets them.
   */
  price?: (event: UsageEvent) => string | null;
}

interface Ending {
  outcome: UsageOutcome;
  status: number;
  errorCode: string | null;
  result?: PartialResult | undefined;
}

const errorStatus = (error: unknown) => (error instanceof GatewayError ? error.status : 500);
const errorCode = (error: unknown) =>
  error instanceof GatewayError ? error.code : "internal_error";
const whole = (value: number) => Math.max(0, Math.round(value));

/**
 * Safety net for routes that begin a tracker (spec 006): if a response finishes while its tracker
 * is still open, records it from the response status (and the error the handler threw) and logs a
 * warning, so an admitted request never goes unrecorded. Register it on every plugin whose routes
 * call `outcomes.begin` (the proxy routes do; spec 014's routes should too).
 */
export function registerOutcomeFallback(app: FastifyInstance): void {
  const errors = new WeakMap<object, unknown>();
  app.addHook("onError", async (request, _reply, error) => {
    errors.set(request, error);
  });
  app.addHook("onResponse", async (request, reply) => {
    const outcome = request.outcome;
    if (!outcome || outcome.done) return;
    request.log.warn(
      { route: request.routeOptions.url, status: reply.statusCode },
      "request outcome recorded by fallback",
    );
    if (reply.statusCode < 400) {
      outcome.succeed({ status: reply.statusCode });
      return;
    }
    const error = errors.get(request);
    outcome.fail(
      error instanceof GatewayError
        ? error
        : new GatewayError(reply.statusCode, "server_error", "internal_error", "unrecorded"),
    );
  });
}

export function createOutcomeHook(deps: OutcomeHookDeps): OutcomeHook {
  const now = deps.now ?? Date.now;

  return {
    begin(request, init) {
      const fields: OutcomeContribution = {
        provider: init.provider,
        servedModel: init.servedModel,
        attempts: init.provider === null ? 0 : 1,
      };
      let done = false;
      let recorded: UsageEvent | undefined;

      /** Spec 007: a contributed cost wins; no upstream call costs "0"; else the price table's. */
      const costOf = (event: UsageEvent): string | null => {
        if (fields.costUsd !== undefined) return fields.costUsd;
        if (!deps.price) return null;
        if (event.attempts === 0 || event.provider === null) return "0";
        try {
          return deps.price(event);
        } catch (error) {
          deps.logger.warn(
            {
              requestId: event.requestId,
              err: error instanceof Error ? error.message : String(error),
            },
            "request cost could not be computed",
          );
          return null;
        }
      };

      const finish = ({ outcome, status, errorCode, result }: Ending) => {
        if (done) return;
        done = true;
        const usage = result?.usage;
        const event: UsageEvent = {
          id: uuidv7(now()),
          schemaVersion: 1,
          occurredAt: new Date(now()).toISOString(),
          requestId: init.requestId,
          teamId: init.principal.teamId,
          keyId: init.principal.keyId,
          operation: init.operation,
          stream: init.stream,
          requestedModel: init.requestedModel,
          provider: fields.provider ?? null,
          servedModel: fields.servedModel ?? null,
          inputTokens: whole(usage?.inputTokens ?? 0),
          outputTokens: whole(usage?.outputTokens ?? 0),
          cachedInputTokens: whole(usage?.cachedInputTokens ?? fields.cachedInputTokens ?? 0),
          estimated: usage !== undefined && result?.estimated === true,
          costUsd: fields.costUsd ?? null,
          status,
          outcome,
          errorCode,
          latencyMs: whole(init.elapsedMs()),
          ttfbMs: result?.ttfbMs === undefined ? null : whole(result.ttfbMs),
          attempts: fields.attempts ?? 0,
          cacheStatus: fields.cacheStatus ?? "miss",
          piiDetections: fields.piiDetections ?? {},
        };
        event.costUsd = costOf(event);
        recorded = event;
        try {
          deps.recorder.record(event);
        } catch (error) {
          // Usage is best-effort (ADR-0007): never fail or delay the response because of it.
          deps.logger.warn(
            {
              requestId: event.requestId,
              eventId: event.id,
              err: error instanceof Error ? error.message : String(error),
            },
            "usage recorder failed",
          );
        }
      };

      const tracker: OutcomeTracker = {
        get done() {
          return done;
        },
        get event() {
          return recorded;
        },
        set(contribution) {
          Object.assign(fields, contribution);
        },
        succeed(result) {
          finish({ outcome: "success", status: result.status ?? 200, errorCode: null, result });
        },
        fail(error) {
          finish({
            outcome: "upstream_error",
            status: errorStatus(error),
            errorCode: errorCode(error),
          });
        },
        failMidstream(error, result) {
          finish({
            outcome: "upstream_error_midstream",
            status: 200,
            errorCode: error instanceof GatewayError ? error.code : "upstream_error",
            result,
          });
        },
        clientClosed(result) {
          finish({
            outcome: "client_closed",
            status: result.headersSent ? 200 : 499,
            errorCode: null,
            result,
          });
        },
        reject(error) {
          if (done) return;
          Object.assign(fields, { provider: null, servedModel: null, attempts: 0 });
          finish({ outcome: "rejected", status: error.status, errorCode: error.code });
        },
      };
      request.outcome = tracker;
      return tracker;
    },
  };
}
