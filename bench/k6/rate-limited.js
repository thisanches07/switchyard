// rate-limited (spec 012, AC-3): load above a low-rpm key's limit. Every rejection must be a
// well-formed 429 with retry-after; bench/run.ts checks after the run that the admitted total
// (warm-up included: the bucket does not know about phases) stays within the limit.
import { buildOptions, chat, fail, isSteady, MODEL, metrics, record, summary } from "./lib.js";
import {
  BASE_HEADERS,
  checkChatCompletion,
  checkErrorBody,
  checkRetryAfter,
  missingHeaders,
  SUCCESS_HEADERS,
} from "./validate.js";

export const options = buildOptions([200, 429]);

const body = { model: MODEL, messages: [{ role: "user", content: "Benchmark limited request." }] };

function problemOf(res) {
  if (res.status === 200) {
    const missing = missingHeaders(res.headers, SUCCESS_HEADERS);
    return checkChatCompletion(res.body) ?? (missing.length ? `missing ${missing}` : null);
  }
  if (res.status === 429) {
    const missing = missingHeaders(res.headers, BASE_HEADERS);
    return (
      checkErrorBody(res.body) ??
      checkRetryAfter(res.headers) ??
      (missing.length ? `missing ${missing}` : null)
    );
  }
  return `status ${res.status}`;
}

export default function () {
  const res = chat(body);
  const problem = problemOf(res);
  if (problem) fail(problem, res);
  metrics.admittedTotal.add(res.status === 200 ? 1 : 0);
  metrics.rejectedTotal.add(res.status === 429 ? 1 : 0);
  if (res.status === 429) {
    if (isSteady()) {
      metrics.requests.add(1);
      metrics.rejected.add(1);
      metrics.rejectLatency.add(res.timings.duration);
    }
    return;
  }
  record(res, problem ? "failed" : "ok");
}

export function handleSummary(data) {
  return summary(data);
}
