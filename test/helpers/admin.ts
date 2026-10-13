/** Creates a team and an API key through the admin API of a running gateway; returns the key. */
export async function createKeyViaAdmin(
  baseUrl: string,
  adminToken: string,
  options: {
    team?: string;
    allowedModels?: string[];
    rpm?: number;
    tpm?: number;
    piiMode?: "off" | "mask" | "block";
    /** Monthly budget of the key (spec 007). */
    monthlyBudgetUsd?: number | string;
  } = {},
): Promise<string> {
  const headers = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
  const teamRes = await fetch(`${baseUrl}/admin/teams`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: options.team ?? `contract-${Date.now()}` }),
  });
  if (teamRes.status !== 201)
    throw new Error(`create team: ${teamRes.status} ${await teamRes.text()}`);
  const team = (await teamRes.json()) as { id: string };

  const keyRes = await fetch(`${baseUrl}/admin/keys`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      teamId: team.id,
      name: "contract-tests",
      ...(options.allowedModels ? { allowedModels: options.allowedModels } : {}),
      ...(options.rpm ? { rpm: options.rpm } : {}),
      ...(options.tpm ? { tpm: options.tpm } : {}),
      ...(options.piiMode ? { piiMode: options.piiMode } : {}),
      ...(options.monthlyBudgetUsd === undefined
        ? {}
        : { monthlyBudgetUsd: options.monthlyBudgetUsd }),
    }),
  });
  if (keyRes.status !== 201) throw new Error(`create key: ${keyRes.status} ${await keyRes.text()}`);
  return ((await keyRes.json()) as { key: string }).key;
}
