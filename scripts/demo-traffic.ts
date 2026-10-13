// Demo traffic for the Grafana dashboards (spec 011, AC-10). Against a running Compose stack:
//   pnpm demo:traffic [--duration 300] [--rps 4] [--mix chat=8,stream=4,embeddings=2,repeat=3,error=1,burst=0.25]
// Uses the `mock` provider only (never a paid provider) and prints what it sent.
// Env: DEMO_GATEWAY_URL (default http://localhost:8080), ADMIN_TOKEN (Compose dev default),
// DEMO_API_KEY to reuse a key instead of creating one.
import {
  type PlannedRequest,
  parseTrafficArgs,
  pickKind,
  planRequests,
  type RequestKind,
} from "./lib/traffic-plan.ts";

const GATEWAY = process.env.DEMO_GATEWAY_URL ?? "http://localhost:8080";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-only-admin-token-change-me";
const TEAM_NAME = "demo-traffic";
/** Requests per minute of the burst key: a burst of 6 always crosses it. */
const LIMITED_RPM = 3;

const admin = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };

const call = (path: string, init: RequestInit) => fetch(`${GATEWAY}${path}`, init);

/** Reuses the `demo-traffic` team, or creates it. */
async function demoTeam(): Promise<string> {
  const list = await call("/admin/teams", { headers: admin });
  if (list.status !== 200) {
    throw new Error(`GET /admin/teams: ${list.status} ${await list.text()} (is ADMIN_TOKEN set?)`);
  }
  const { data } = (await list.json()) as { data: { id: string; name: string }[] };
  const existing = data.find((team) => team.name === TEAM_NAME);
  if (existing) return existing.id;
  const created = await call("/admin/teams", {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ name: TEAM_NAME }),
  });
  if (created.status !== 201) throw new Error(`POST /admin/teams: ${created.status}`);
  return ((await created.json()) as { id: string }).id;
}

/** Key secrets are shown once, so keys are created per run (or passed in DEMO_API_KEY). */
async function createKey(teamId: string, name: string, rpm?: number): Promise<string> {
  const res = await call("/admin/keys", {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ teamId, name, ...(rpm === undefined ? {} : { rpm }) }),
  });
  if (res.status !== 201) throw new Error(`POST /admin/keys: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { key: string }).key;
}

/** Refuses to run unless `mock/*` really is the mock provider (only its echo model echoes). */
async function assertMockProvider(key: string): Promise<void> {
  const probe = `demo-traffic preflight ${Date.now()}`;
  const res = await call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/echo", messages: [{ role: "user", content: probe }] }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
  };
  if (res.status !== 200 || body.choices?.[0]?.message?.content !== probe) {
    throw new Error(
      `the "mock" provider did not answer as the mock echo model (status ${res.status}); ` +
        "refusing to send demo traffic to a provider that may not be the built-in mock",
    );
  }
}

async function send(request: PlannedRequest, keys: Record<PlannedRequest["key"], string>) {
  try {
    const res = await call(request.path, {
      method: "POST",
      headers: { authorization: `Bearer ${keys[request.key]}`, "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    await res.arrayBuffer();
    return String(res.status);
  } catch (error) {
    return error instanceof Error ? error.name : "error";
  }
}

const options = parseTrafficArgs(process.argv.slice(2));
const teamId = await demoTeam();
const keys = {
  main: process.env.DEMO_API_KEY ?? (await createKey(teamId, `demo-${Date.now()}`)),
  limited: await createKey(teamId, `demo-burst-${Date.now()}`, LIMITED_RPM),
};
await assertMockProvider(keys.main);

console.log(
  `Sending demo traffic to ${GATEWAY} for ${options.durationSeconds} s at ${options.rps} req/s ` +
    `(mock provider only; team "${TEAM_NAME}"). Mix: ${JSON.stringify(options.mix)}`,
);

/** kind → status → count */
const sent = new Map<RequestKind, Map<string, number>>();
const inFlight = new Set<Promise<void>>();
const started = Date.now();
const intervalMs = 1000 / options.rps;
let slot = 0;

while (Date.now() - started < options.durationSeconds * 1000) {
  const kind = pickKind(options.mix, Math.random);
  for (const request of planRequests(kind, slot, Math.random)) {
    const task = send(request, keys).then((status) => {
      const byStatus = sent.get(kind) ?? new Map<string, number>();
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      sent.set(kind, byStatus);
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }
  slot += 1;
  const next = started + slot * intervalMs;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - Date.now())));
}
await Promise.all(inFlight);

console.log("\nSent (kind: status × count):");
let total = 0;
for (const [kind, byStatus] of sent) {
  const parts = [...byStatus].map(([status, count]) => `${status} × ${count}`);
  total += [...byStatus.values()].reduce((sum, count) => sum + count, 0);
  console.log(`  ${kind.padEnd(10)} ${parts.join(", ")}`);
}
console.log(
  `  total      ${total} requests. Open Grafana: http://localhost:3000 (Switchyard folder)`,
);
