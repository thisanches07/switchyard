// streaming (spec 012, AC-3): SSE streams with the mock's chunk delay. Time to first byte is
// k6's `timings.waiting` (the gateway sends headers with the first chunk); total is `duration`.
// Run once with MODE=direct (baseline) and once with MODE=gateway.
import {
  buildOptions,
  chat,
  fail,
  isSteady,
  MODE,
  MODEL,
  metrics,
  record,
  summary,
} from "./lib.js";
import { checkSseStream, header, missingHeaders, STREAM_HEADERS } from "./validate.js";

export const options = buildOptions([200]);

const body = {
  model: MODEL,
  stream: true,
  messages: [{ role: "user", content: "Benchmark stream." }],
};

export default function () {
  const res = chat(body);
  let problem = res.status === 200 ? null : `status ${res.status}`;
  if (!problem && !String(header(res.headers, "content-type")).startsWith("text/event-stream")) {
    problem = "content-type is not text/event-stream";
  }
  if (!problem) problem = checkSseStream(res.body);
  if (!problem && MODE === "gateway") {
    const missing = missingHeaders(res.headers, STREAM_HEADERS);
    if (missing.length > 0) problem = `missing ${missing.join(", ")}`;
  }
  if (problem) fail(problem, res);
  record(res, problem ? "failed" : "ok");
  if (isSteady()) metrics.ttfb.add(res.timings.waiting);
}

export function handleSummary(data) {
  return summary(data);
}
