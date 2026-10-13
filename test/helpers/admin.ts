/** Creates a team and an API key through the admin API of a running gateway; returns the key. */
export async function createKeyViaAdmin(
  baseUrl: string,
  adminToken: string,
  options: { team?: string; allowedModels?: string[] } = {},
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
    }),
  });
  if (keyRes.status !== 201) throw new Error(`create key: ${keyRes.status} ${await keyRes.text()}`);
  return ((await keyRes.json()) as { key: string }).key;
}
