export function parseLimit(
  value: string | null | undefined,
  fallback: number,
  max: number,
): number {
  if (!value) {
    return fallback;
  }

  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    return fallback;
  }

  return Math.min(limit, max);
}

export function parseBool(value: string | null | undefined): boolean {
  return value === "1" || value === "true";
}
