/**
 * Whether a key may use a model (spec 004, AC-5). Entries match the requested `model`
 * (alias or provider/model), the resolved `provider/model`, or `provider/*`.
 */
export function isModelAllowed(
  allowed: readonly string[] | null,
  requested: string,
  resolvedRef: string,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  const provider = resolvedRef.slice(0, resolvedRef.indexOf("/"));
  return allowed.some(
    (entry) => entry === requested || entry === resolvedRef || entry === `${provider}/*`,
  );
}
