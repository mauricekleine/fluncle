// The pure primitives behind the Log ID coordinate, shared by the server
// generator (lib/server/log-id.ts), the client-safe format guard (lib/log-id.ts),
// and the Galaxy placement (game/placement.ts). No server-only deps — this stays
// importable from client code.

/** The Fluncle epoch: 2026-05-30 = day 0 (see lib/server/log-id.ts). */
export const EPOCH_MS = Date.UTC(2026, 4, 30);
export const DAY_MS = 86_400_000;

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
