import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import type { CheckStatus, DependencyCheck, ReadinessResult } from "../../core/health.js";

const tracer = trace.getTracer("switchyard");
const failures = metrics
  .getMeter("switchyard")
  .createCounter("switchyard_readiness_check_failures_total", {
    description: "Readiness checks that failed or timed out, by dependency",
  });

class CheckTimeout extends Error {}

/** Runs all checks in parallel; each one is aborted and reported as `timeout` after `timeoutMs`. */
export async function runReadiness(
  checks: readonly DependencyCheck[],
  timeoutMs: number,
): Promise<ReadinessResult> {
  const statuses = await Promise.all(checks.map((c) => runCheck(c, timeoutMs)));

  const result: ReadinessResult = { ready: true, checks: {}, failing: [] };
  checks.forEach((c, i) => {
    const status = statuses[i] ?? "error";
    result.checks[c.name] = status;
    if (status !== "ok") {
      result.ready = false;
      result.failing.push(c.name);
    }
  });
  return result;
}

function runCheck(dep: DependencyCheck, timeoutMs: number): Promise<CheckStatus> {
  return tracer.startActiveSpan("switchyard.readyz.check", async (span) => {
    span.setAttribute("switchyard.dependency", dep.name);
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const reason = new CheckTimeout(`${dep.name} check timed out after ${timeoutMs} ms`);
        controller.abort(reason);
        reject(reason);
      }, timeoutMs);
    });

    let status: CheckStatus;
    try {
      await Promise.race([dep.check(controller.signal), timeout]);
      status = "ok";
    } catch (error) {
      status = error instanceof CheckTimeout ? "timeout" : "error";
      // Only the error class is recorded; messages may contain connection strings.
      span.setStatus({ code: SpanStatusCode.ERROR, message: status });
      failures.add(1, { dependency: dep.name, status });
    } finally {
      clearTimeout(timer);
    }
    span.setAttribute("switchyard.check.status", status);
    span.end();
    return status;
  });
}
