// Log ID — the permanent coordinate for a finding in the Galaxy.
//
// Format: `sector.orbit.mark`, e.g. "009.4.6K".
//
// - sector: days since the Fluncle epoch (2026-05-30), from the FOUND date.
//   Chronological but reads as a coordinate, not a counter. Zero-padded to 3,
//   widening to 4 on its own around 2029-02-22. The epoch is lore: on the day
//   this scheme was set, its keeper had been alive 13131 days — digit sum 9 —
//   so "today" read 009, which fixes day 0 at 2026-05-30.
// - orbit + mark: derived from a stable hash of the recording's identity (its
//   ISRC, or the Spotify id as fallback), so the tail looks found, not spelled,
//   and two different recordings effectively never collide.
//
// Permanent: computed once at add time and STORED, never recomputed — so it
// survives any later change to this algorithm or epoch. resolveLogId() handles
// the astronomically-rare collision deterministically (same sector, fresh tail).

const EPOCH_MS = Date.UTC(2026, 4, 30); // 2026-05-30 = day 0
const DAY_MS = 86_400_000;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type LogIdInput = {
  /** ISO timestamp of when Fluncle found it (the added/found date). */
  foundAt: string;
  /** Preferred hash seed: the recording's ISRC. */
  isrc?: string | null;
  /** Fallback hash seed, always present: the Spotify track id. */
  trackId: string;
};

/** Stable 32-bit FNV-1a hash → non-negative integer. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function sector(foundAt: string): string {
  const found = new Date(foundAt).getTime();
  const days = Math.max(0, Math.floor((found - EPOCH_MS) / DAY_MS));

  return String(days).padStart(3, "0");
}

// orbit + mark from decorrelated slices of one hash. `attempt` salts the seed so
// a collision can be resolved without moving the sector (chronology is fixed).
function tail(seed: string, attempt: number): string {
  const hash = fnv1a(attempt === 0 ? seed : `${seed}#${attempt}`);
  const orbit = hash % 10;
  const markNumber = (hash >>> 8) % 10;
  const markLetter = LETTERS[(hash >>> 16) % LETTERS.length];

  return `${orbit}.${markNumber}${markLetter}`;
}

/** The deterministic candidate Log ID for a finding (attempt 0 is canonical). */
export function logIdCandidate(input: LogIdInput, attempt = 0): string {
  const seed = input.isrc?.trim() || input.trackId;

  return `${sector(input.foundAt)}.${tail(seed, attempt)}`;
}

/**
 * Resolve a unique Log ID: try the canonical candidate, then deterministic
 * salted re-hashes (same sector, new tail) until `isTaken` reports it free.
 */
export async function resolveLogId(
  input: LogIdInput,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = logIdCandidate(input, attempt);

    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }

  throw new Error("log-id: exhausted attempts resolving a unique coordinate");
}
