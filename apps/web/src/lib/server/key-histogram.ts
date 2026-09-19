// THE ARCHIVE'S KEY HISTOGRAM — `key → how many tracks carry that spelling`, read once.
//
// ONE `group by key` over `tracks_key_idx`: two dozen distinct values, answered from the index
// without touching the table. Every keyed track counts, certified or not — a catalogue track is
// rankable the moment it has a key.
//
// It is a property of the WHOLE archive, so it is the same answer for every reader and it moves
// only when a track is keyed. That is what makes ONE isolate-level memo correct for both of its
// consumers (`getMixChainDepth`, the `/mix` depth gate; and `namedMoveKeys`, the rail's `key in (…)`
// pre-filter — both in tracks.ts). They walk `tracks_key_idx` separately unless the shared memo
// remembered its result, so every `/mix` rail paid a fresh full walk of an index that grows with the
// catalogue to rebuild two dozen strings that had not moved.
//
// It lives in its own module rather than inside tracks.ts so `integration-db.ts` can clear it per
// fixture (below) without importing that module's whole surface.

import { getDb, typedRows } from "./db";
import { readProjectedAggregateBuckets } from "./public-projection-cutover";

/** One bucket: a stored key spelling and how many tracks carry it. */
export type KeyHistogramRow = { count: number; key: string | null };

/**
 * How long a read is reused. The memo holds ~24 scale SPELLINGS, not a set of tracks: a spelling
 * enters it the first time any track carries that key and then never moves again, so the answer is
 * one of the most stable facts the archive has. Both consumers accept staleness on exactly that —
 * the rail's pre-filter over a spelling minted minutes ago is the same pre-filter, and the depth
 * gate opens once, for good, on a measurement that has to cross a floor of thousands of tracks.
 * The window is long because the read it replaces is not free: cold, it is a settings lookup plus
 * a walk of an index that grows with every crawled track.
 */
const KEY_HISTOGRAM_TTL_MS = 600_000;

let cache: { at: number; rows: readonly KeyHistogramRow[] } | null = null;
let inFlight: Promise<readonly KeyHistogramRow[]> | null = null;
// Bumped by every reset. A read that started before the reset carries the old generation and is
// discarded on arrival, so a refresh outstanding against a retired fixture cannot install itself.
let generation = 0;

/**
 * The histogram, from the memo when it is warm and from `tracks_key_idx` when it is not.
 *
 * A STALE MEMO STILL ANSWERS. Past the window the remembered spellings are served immediately and
 * the refresh runs behind the request, so exactly one caller per isolate ever waits on this read —
 * the first. Concurrent cold callers share one in-flight read rather than each walking the index,
 * which is what keeps a burst of `/mix` rails from multiplying the one walk they all need.
 */
export async function readKeyHistogram(): Promise<readonly KeyHistogramRow[]> {
  const warm = cache;

  if (warm) {
    if (Date.now() - warm.at >= KEY_HISTOGRAM_TTL_MS) {
      // A failed refresh keeps the remembered spellings and is retried by the next reader; it must
      // never surface as an unhandled rejection on a request that was already answered.
      refresh().catch(() => undefined);
    }

    return warm.rows;
  }

  return refresh();
}

/** The one read, shared by every caller that arrives while it is outstanding. */
function refresh(): Promise<readonly KeyHistogramRow[]> {
  const outstanding = inFlight;

  if (outstanding !== null) {
    return outstanding;
  }

  const startedAt = generation;
  const settle = (): void => {
    if (generation === startedAt) {
      inFlight = null;
    }
  };
  const read = readHistogramRows().then(
    (rows) => {
      if (generation === startedAt) {
        cache = { at: Date.now(), rows };
      }

      settle();

      return rows;
    },
    (error: unknown) => {
      settle();

      throw error;
    },
  );

  inFlight = read;

  return read;
}

async function readHistogramRows(): Promise<readonly KeyHistogramRow[]> {
  const db = await getDb();
  const projected = await readProjectedAggregateBuckets(db, "key");

  if (projected !== undefined) {
    return projected.map(({ bucket, count }) => ({ count, key: bucket }));
  }

  const result = await db.execute(
    `select key, count(*) as count from tracks where key is not null group by key`,
  );

  return typedRows<KeyHistogramRow>(result.rows);
}

/**
 * Drop the memo. An isolate-level cache outlives a test fixture, so `createIntegrationDb` calls
 * this on every fresh database — otherwise one suite's key spellings would answer the next suite's
 * rail, which is exactly the kind of cross-test leakage that harness promises there is none of.
 * The in-flight read is dropped with it: a refresh still resolving against the previous fixture's
 * database may not install itself as the next fixture's answer.
 */
export function resetKeyHistogramCache(): void {
  cache = null;
  inFlight = null;
  generation += 1;
}
