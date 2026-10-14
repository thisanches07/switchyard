// chaos (spec 012, AC-3): the alias's primary candidate fails 30 % of requests and the secondary
// is healthy; the result is the client-visible success rate (target T2). A well-formed 502/503/504
// is a failed request, not a correctness error (design decision 2): T2 must be able to miss.
import { buildOptions, chat, fail, MODEL, record, summary } from "./lib.js";
import {
  BASE_HEADERS,
  checkChatCompletion,
  checkErrorBody,
  missingHeaders,
  SUCCESS_HEADERS,
} from "./validate.js";

const FAILURES = [502, 503, 504];
export const options = buildOptions([200, ...FAILURES]);

const body = { model: MODEL, messages: [{ role: "user", content: "Benchmark chaos request." }] };

export default function () {
  const res = chat(body);
  let problem = null;
  let outcome = "ok";
  if (res.status === 200) {
    const missing = missingHeaders(res.headers, SUCCESS_HEADERS);
    problem = checkChatCompletion(res.body) ?? (missing.length ? `missing ${missing}` : null);
  } else if (FAILURES.includes(res.status)) {
    outcome = "failed";
    const missing = missingHeaders(res.headers, BASE_HEADERS);
    problem = checkErrorBody(res.body) ?? (missing.length ? `missing ${missing}` : null);
  } else {
    problem = `status ${res.status}`;
  }
  if (problem) {
    fail(problem, res);
    outcome = "failed";
  }
  record(res, outcome);
}

export function handleSummary(data) {
  return summary(data);
}
