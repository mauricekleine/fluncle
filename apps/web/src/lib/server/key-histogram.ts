// THE ARCHIVE'S KEY HISTOGRAM — `key → how many tracks carry that spelling`, read once.
//
// ONE `group by key` over `tracks_key_idx`: two dozen distinct values, answered from the index
// without touching the table. Every keyed track counts, certified or not — a catalogue track is
// rankable the moment it has a key.
//
// It is a property of the WHOLE archive, so it is the same answer for every reader and it moves
// only when a track is keyed. That is what makes ONE isolate-level memo correct for both of its
// consumers (`getMixChainDepth`, the `/mix` depth gate; and `namedMoveKeys`, the rail's `key in (…)`
// pre-filter — both in tracks.ts). They used to walk `tracks_key_idx` separately and only the gate
// remembered its result, so every `/mix` rail paid a fresh full walk of an index that grows with the
// catalogue to rebuild two dozen strings that had not moved.
//
// It lives in its own module rather than inside tracks.ts so `integration-db.ts` can clear it per
// fixture (below) without importing that module's whole surface.

import { getDb, typedRows } from "./db";

/** One bucket: a stored key spelling and how many tracks carry it. */
export type KeyHistogramRow = { count: number; key: string | null };

/**
 * How long a read is reused. The gate has always accepted a minute of staleness on exactly this
 * fact, and a newly-keyed track reaching the rail's spelling list a minute late costs nothing —
 * the list is a set of ~24 scale spellings, not a set of tracks.
 */
const KEY_HISTOGRAM_TTL_MS = 60_000;

let cache: { at: number; rows: readonly KeyHistogramRow[] } | null = null;

/** The histogram, from the memo when it is warm and from `tracks_key_idx` when it is not. */
export async function readKeyHistogram(): Promise<readonly KeyHistogramRow[]> {
  const now = Date.now();

  if (cache && now - cache.at < KEY_HISTOGRAM_TTL_MS) {
    return cache.rows;
  }

  const db = await getDb();
  const result = await db.execute(
    `select key, count(*) as count from tracks where key is not null group by key`,
  );
  const rows: readonly KeyHistogramRow[] = typedRows<KeyHistogramRow>(result.rows);

  cache = { at: now, rows };

  return rows;
}

/**
 * Drop the memo. An isolate-level cache outlives a test fixture, so `createIntegrationDb` calls
 * this on every fresh database — otherwise one suite's key spellings would answer the next suite's
 * rail, which is exactly the kind of cross-test leakage that harness promises there is none of.
 */
export function resetKeyHistogramCache(): void {
  cache = null;
}
