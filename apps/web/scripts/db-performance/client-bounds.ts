export const DATABASE_CLIENT_BOUNDS = {
  benchmark: 1,
  countFanout: 3,
  file: 1,
  local: 1,
  maintenance: 1,
  primary: 4,
  readiness: 1,
  seed: 1,
  telemetry: 3,
  test: 1,
} as const;

export type DatabaseClientClass = keyof typeof DATABASE_CLIENT_BOUNDS;

export function validateClientBounds(
  bounds: Readonly<Record<DatabaseClientClass, number>>,
): string[] {
  const violations: string[] = [];

  for (const [clientClass, expected] of Object.entries(DATABASE_CLIENT_BOUNDS) as [
    DatabaseClientClass,
    number,
  ][]) {
    const actual = bounds[clientClass];

    if (!Number.isSafeInteger(actual) || actual < 1) {
      violations.push(`${clientClass} has no positive explicit per-client bound`);
    } else if (actual !== expected) {
      violations.push(`${clientClass} bound ${actual} differs from the contract ${expected}`);
    }
  }

  return violations;
}
