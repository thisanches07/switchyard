const UNITS: Record<string, number> = {
  B: 1,
  kB: 1000,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};

/** Parses the "used" half of a `docker stats` MemUsage value such as `685MiB / 1.919GiB`. */
export function parseMemUsage(value: string): number {
  const match = value.trim().match(/^([\d.]+)\s*([A-Za-z]+)\s*\//);
  const amount = match?.[1];
  const unit = match?.[2];
  const factor = unit === undefined ? undefined : UNITS[unit];
  if (amount === undefined || factor === undefined) {
    throw new Error(`cannot parse docker memory usage: "${value}"`);
  }
  return Number(amount) * factor;
}

export function totalMemoryBytes(values: readonly string[]): number {
  return values.reduce((sum, v) => sum + parseMemUsage(v), 0);
}
