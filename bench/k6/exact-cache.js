// exact-cache (spec 012, AC-3): identical deterministic requests (`temperature: 0`) against the
// gateway with the exact cache enabled. Results are cache hits; the hit ratio comes from the
// `x-switchyard-cache` header (spec 009). Until spec 009 lands the header is absent: responses are
// counted as unlabelled, and only REQUIRE_CACHE_HEADER=true makes that a correctness error.
import { buildOptions, chat, fail, isSteady, MODEL, metrics, record, summary } from "./lib.js";
import { cacheStatus, checkChatCompletion, missingHeaders, SUCCESS_HEADERS } from "./validate.js";

export const options = buildOptions([200]);

const requireHeader = __ENV.REQUIRE_CACHE_HEADER === "true";
const body = {
  model: MODEL,
  temperature: 0,
  messages: [{ role: "user", content: "Benchmark cached request." }],
};

export default function () {
  const res = chat(body);
  let problem = res.status === 200 ? checkChatCompletion(res.body) : `status ${res.status}`;
  if (!problem) {
    const missing = missingHeaders(res.headers, SUCCESS_HEADERS);
    if (missing.length > 0) problem = `missing ${missing.join(", ")}`;
  }
  const cache = cacheStatus(res.headers);
  if (!problem && cache === "invalid") problem = "x-switchyard-cache is not hit or miss";
  if (!problem && cache === "absent" && requireHeader) problem = "missing x-switchyard-cache";
  if (problem) fail(problem, res);
  record(res, problem ? "failed" : "ok");
  if (isSteady()) {
    metrics.cacheHit.add(cache === "hit" ? 1 : 0);
    metrics.cacheMiss.add(cache === "miss" ? 1 : 0);
    metrics.cacheUnlabelled.add(cache === "absent" ? 1 : 0);
  }
}

export function handleSummary(data) {
  return summary(data);
}
