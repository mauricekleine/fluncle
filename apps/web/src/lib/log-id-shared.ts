// The pure primitives behind the Log ID coordinate, shared by the server
// generator (lib/server/log-id.ts), the client-safe format guard (lib/log-id.ts),
// and the Galaxy placement (game/placement.ts). No server-only deps — this stays
// importable from client code.

/** The Fluncle epoch: 2026-05-30 = day 0 (see lib/server/log-id.ts). */
const EPOCH_MS = Date.UTC(2026, 4, 30);
const DAY_MS = 86_400_000;

/** Stable 32-bit FNV-1a hash → non-negative integer. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

/** The day number of a found date (days since the epoch, clamped to ≥ 0; 0 on an unparseable date). */
export function sectorDay(foundAt: string): number {
  const found = new Date(foundAt).getTime();

  return Number.isNaN(found) ? 0 : Math.max(0, Math.floor((found - EPOCH_MS) / DAY_MS));
}

/**
 * The half-open UTC millisecond range a sector-day covers: `[startMs, endMs)` where
 * `startMs = EPOCH_MS + sector·DAY_MS`. The inverse of `sectorDay` — used by the
 * logbook gap query to find findings whose `added_at` falls in a given sector-day
 * (an ISO-string range comparison, since ISO timestamps sort chronologically).
 */
export function sectorRange(sector: number): { endMs: number; startMs: number } {
  const startMs = EPOCH_MS + sector * DAY_MS;

  return { endMs: startMs + DAY_MS, startMs };
}

/** The UTC-midnight ISO date (`YYYY-MM-DDT00:00:00.000Z`) a sector-day begins on. */
export function sectorDateISO(sector: number): string {
  return new Date(sectorRange(sector).startMs).toISOString();
}

/**
 * The display/URL form of a sector number: zero-padded to 3 digits so it reads like
 * a Log ID's sector segment (e.g. `36` → `036`, matching `036.7.2I`). Sectors past
 * 999 render at their natural width (no truncation).
 */
export function formatSector(sector: number): string {
  return String(sector).padStart(3, "0");
}

/**
 * Parse a `/logbook/<sector>` route param into a sector number, tolerating leading
 * zeros (`036` → 36). Returns null for anything that isn't a non-negative integer.
 */
export function parseSectorParam(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const sector = Number.parseInt(value, 10);

  return Number.isSafeInteger(sector) && sector >= 0 ? sector : null;
}
