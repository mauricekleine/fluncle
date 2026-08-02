// THE HUB-COUNTS RECONCILIATION SWEEP — the self-healing backstop under the maintained
// per-entity counters (docs/db-scale-backlog Wave 2 keystone 2, slice C).
//
// The write side (./hub-counts.ts) moves `renderable_track_count` / `certified_finding_count` on
// `labels`, `albums` and `artists` as DELTAS, because recompute-from-truth measured 27,400 ms at
// 150k hosted against ~200 ms for the delta form. That trade buys speed and takes on one debt: a
// maintained counter DRIFTS, and its failure mode is silent. Three ways, none fixable from inside
// the write side:
//
//   - a missed write path (a new edge-writer that forgets its delta),
//   - a non-atomic bulk op (a half-applied pair IS drift),
//   - an OUT-OF-BAND write — the operator's catalogue-prune skill deletes tracks straight out of
//     the database, and no server-side track-delete path exists at all.
//
// A deploy-window skew between a one-time backfill and delta-maintained writes can leave hub counts
// wrong until a manual reconcile. This module is that manual reconcile, nightly.
//
// ── THE SHAPE: TWO STATEMENTS PER TABLE, NEVER A LOOP ──────────────────────────────────────
//
// 1. THE GROUPED CORRECTION. One `UPDATE <entity> … FROM (SELECT <fk>, count(*), sum(is_catalogue
//    = 0) … GROUP BY <fk>) src WHERE <entity>.id = src.<fk> AND (the stored counts DIFFER)`. The
//    counts-differ guard is the load-bearing half: without it `rowsAffected` counts every row
//    re-written (i.e. every entity in the archive), and with it `rowsAffected` IS the number of
//    rows that were actually WRONG. The reported number is the drift, exactly — which is the
//    whole point, since a non-zero reading is the signal that a write path is leaking.
//
// 2. THE ZERO-TRUTH PASS. An entity whose last track was deleted out of band keeps a stale
//    NON-ZERO count and appears in NO group, so statement 1 can never reach it (there is no `src`
//    row to join). A second small `UPDATE … SET both = 0 WHERE (counts <> 0) AND id NOT IN
//    (<the same source's keys>)` closes exactly that hole. Its `rowsAffected` folds into the same
//    per-table `corrected` total — one number per table, honest about both halves.
//
//    WHY `NOT IN` AND NOT A CORRELATED `NOT EXISTS`. A correlated anti-join would ride the existing
//    per-column index and short-circuit, so it is not obviously slower — the reason is CORRECTNESS,
//    not cost. The `NOT IN` subselect is the SAME source expression as the grouped correction
//    directly above it, verbatim, so the two halves provably agree on what "has tracks" means. The
//    entire bug class this sweep exists to prevent is a fix that disagrees with what the page reads;
//    a second, differently-written predicate is exactly how that creeps back in. It also costs one
//    materialization of a pass the tick already makes, at a nightly off-peak cadence.
//
// ── THE PINNED ARTISTS SOURCE ──────────────────────────────────────────────────────────────
//
// The artists source MUST be `track_artists ta JOIN tracks t ON t.track_id = ta.track_id`, never
// raw `track_artists`. Production carries ORPHANED edges left
// by out-of-band track deletion — and the hub read paths all join `tracks`. Counting raw edges
// would "correct" the counters into disagreeing with what actually RENDERS: a fix that breaks the
// page it was meant to protect. The join drops an orphan edge, which is precisely right, and the
// zero-truth pass carries the SAME join so an artist left holding only orphan edges is zeroed
// rather than pinned at its stale count.
//
// Labels and albums group over `tracks` directly. Their `WHERE label_id / album_id IS NOT NULL`
// is also load-bearing, not decoration: a NULL inside the zero-truth `NOT IN (…)` subselect makes
// the whole predicate NULL, which matches NO rows and would silently disable that pass.
//
// `certified` keys off `tracks.is_catalogue = 0` (keystone 1's materialized discriminator), never
// a `findings` join — the same rule the write side follows, so truth here means the same thing
// truth means there.
//
// Cost, and what is PROVEN vs INFERRED. The grouped correction is the shape
// `scripts/backfill-hub-counts.ts` already ships and slice A already ran: the full recompute
// measured 19.3 s at 150k hosted as three correlated statements, and the counts-differ guard only
// narrows what gets written. The zero-truth pass is NEW and has NOT been measured against hosted
// Turso — it adds one more materialization of a source the tick already scans, which is why it is
// judged safe at this cadence, but that is inference, not a measurement (AGENTS.md: never trust the
// local database for a scale claim). It runs off-peak nightly behind a 600 s unit timeout, the pass
// is idempotent, and nothing on the hub READ path depends on it, so an over-long tick degrades to
// "skips a night" rather than to a wedged page.

import { getDb } from "./db";

/** One table's reconciliation outcome — an object so the shape has room to grow. */
export type HubCountsTableResult = {
  /** Entity rows whose stored counters disagreed with truth and were rewritten this pass. */
  corrected: number;
};

/** What one whole reconciliation pass reports. */
export type HubCountsReconcileResult = {
  albums: HubCountsTableResult;
  artists: HubCountsTableResult;
  labels: HubCountsTableResult;
  /** Wall-clock milliseconds the whole pass took, server-side. */
  tookMs: number;
};

/**
 * One table's pair of statements: the grouped correction, then the zero-truth pass. Kept as data
 * (not three hand-rolled functions) so the three tables provably share ONE shape and a reader can
 * diff them at a glance.
 */
type ReconcilePass = {
  /** The grouped `UPDATE … FROM (…) WHERE id = src.fk AND counts differ`. */
  correct: string;
  key: "albums" | "artists" | "labels";
  /** The `UPDATE … SET both = 0` for entities absent from the grouped source. */
  zero: string;
};

/** The three passes, in the order the result reports them. */
const PASSES: ReconcilePass[] = [
  {
    correct: `update labels
                set renderable_track_count = src.renderable,
                    certified_finding_count = src.certified
              from (select label_id,
                           count(*) as renderable,
                           sum(case when is_catalogue = 0 then 1 else 0 end) as certified
                    from tracks
                    where label_id is not null
                    group by label_id) src
              where labels.id = src.label_id
                and (labels.renderable_track_count <> src.renderable
                     or labels.certified_finding_count <> src.certified)`,
    key: "labels",
    zero: `update labels
             set renderable_track_count = 0,
                 certified_finding_count = 0
           where (renderable_track_count <> 0 or certified_finding_count <> 0)
             and id not in (select label_id from tracks where label_id is not null)`,
  },
  {
    correct: `update albums
                set renderable_track_count = src.renderable,
                    certified_finding_count = src.certified
              from (select album_id,
                           count(*) as renderable,
                           sum(case when is_catalogue = 0 then 1 else 0 end) as certified
                    from tracks
                    where album_id is not null
                    group by album_id) src
              where albums.id = src.album_id
                and (albums.renderable_track_count <> src.renderable
                     or albums.certified_finding_count <> src.certified)`,
    key: "albums",
    zero: `update albums
             set renderable_track_count = 0,
                 certified_finding_count = 0
           where (renderable_track_count <> 0 or certified_finding_count <> 0)
             and id not in (select album_id from tracks where album_id is not null)`,
  },
  {
    // THE PINNED SHAPE: the source joins `tracks`, so an ORPHANED edge (a `track_artists` row
    // whose track was deleted out of band) does NOT count. The
    // hub reads join `tracks` too, so a raw-edge count would correct these into disagreeing with
    // what renders. The zero pass carries the same join for the same reason.
    correct: `update artists
                set renderable_track_count = src.renderable,
                    certified_finding_count = src.certified
              from (select ta.artist_id,
                           count(*) as renderable,
                           sum(case when t.is_catalogue = 0 then 1 else 0 end) as certified
                    from track_artists ta
                    join tracks t on t.track_id = ta.track_id
                    group by ta.artist_id) src
              where artists.id = src.artist_id
                and (artists.renderable_track_count <> src.renderable
                     or artists.certified_finding_count <> src.certified)`,
    key: "artists",
    zero: `update artists
             set renderable_track_count = 0,
                 certified_finding_count = 0
           where (renderable_track_count <> 0 or certified_finding_count <> 0)
             and id not in (select ta.artist_id
                            from track_artists ta
                            join tracks t on t.track_id = ta.track_id)`,
  },
];

/**
 * Run ONE reconciliation pass over all three entity tables and report how many rows each one had
 * to correct. Idempotent by construction: on a healthy archive every statement matches zero rows,
 * so a re-run reports `{ corrected: 0 }` across the board and writes nothing.
 *
 * The statements are deliberately NOT batched into one transaction. Each is independently
 * self-correcting and order-free, and a nightly backstop that half-fails should leave the half it
 * did fix in place — the next tick closes the rest.
 */
export async function reconcileHubCounts(): Promise<HubCountsReconcileResult> {
  const db = await getDb();
  const started = Date.now();
  const corrected = { albums: 0, artists: 0, labels: 0 };

  for (const pass of PASSES) {
    const grouped = await db.execute(pass.correct);
    const zeroed = await db.execute(pass.zero);
    corrected[pass.key] = grouped.rowsAffected + zeroed.rowsAffected;
  }

  return {
    albums: { corrected: corrected.albums },
    artists: { corrected: corrected.artists },
    labels: { corrected: corrected.labels },
    tookMs: Date.now() - started,
  };
}
