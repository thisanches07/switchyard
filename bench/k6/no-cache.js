// no-cache (spec 012, AC-3): non-streaming chat through auth, rate limit and budget, caches off.
// Run once with MODE=direct (baseline, straight to the mock) and once with MODE=gateway.
import { buildOptions, chat, fail, MODE, MODEL, record, summary } from "./lib.js";
import { checkChatCompletion, missingHeaders, SUCCESS_HEADERS } from "./validate.js";

export const options = buildOptions([200]);

// No `temperature`: never eligible for the exact cache (spec 009, AC-2) even if one were on.
const body = { model: MODEL, messages: [{ role: "user", content: "Benchmark request." }] };

export default function () {
  const res = chat(body);
  let problem = res.status === 200 ? checkChatCompletion(res.body) : `status ${res.status}`;
  if (!problem && MODE === "gateway") {
    const missing = missingHeaders(res.headers, SUCCESS_HEADERS);
    if (missing.length > 0) problem = `missing ${missing.join(", ")}`;
  }
  if (problem) fail(problem, res);
  record(res, problem ? "failed" : "ok");
}

export function handleSummary(data) {
  return summary(data);
}
