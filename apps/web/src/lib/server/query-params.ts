// Shared query-param coercion for the web's HTTP surfaces — the tolerant
// string → number/bool parsing the public/admin routes and the oRPC handlers BOTH
// apply to raw query params. One definition each so a copy can't drift; the live
// routes read `string | null` (URLSearchParams.get), the oRPC handlers read
// `string | undefined` (the detailed-input query bag), so both accept
// `string | null | undefined`.

/**
 * Parse + clamp an incoming `limit` query param: a missing, non-integer, or `< 1`
 * value degrades to `fallback`; otherwise it is capped at `max`. The contracts keep
 * `limit` a raw string (coercion would 400 on `?limit=abc`), so this reproduces the
 * legacy tolerance. Each caller passes its own DEFAULT/MAX so the bounds stay where
 * they read.
 */
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

/** A tolerant boolean query param: `"1"` / `"true"` is true, anything else false. */
export function parseBool(value: string | null | undefined): boolean {
  return value === "1" || value === "true";
}
