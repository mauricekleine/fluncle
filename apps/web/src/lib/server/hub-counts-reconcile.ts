// THE HUB-COUNTS RECONCILIATION SWEEP — the self-healing backstop under the maintained
// per-entity counters (docs/db-scale-backlog Wave 2 keystone 2, slice C).
//
// The write side (./hub-counts.ts) moves `renderable_track_count` / `certified_finding_count` on
// `labels`, `albums` and `artists` (plus `rankable_track_count` on artists) as DELTAS, because
// recompute-from-truth measured 27,400 ms at 150k hosted against ~200 ms for the delta form. That
// trade buys speed and takes on one debt: a maintained counter DRIFTS, and its failure mode is
// silent. Three ways, none fixable from inside the write side:
//
//   - a missed write path (a new edge-writer that forgets its delta),
//   - a non-atomic bulk op (a half-applied pair IS drift),
//   - an OUT-OF-BAND write — the operator's catalogue-prune skill deletes tracks straight out of
//     the database, and no server-side track-delete path exists at all.
//
// This module recomputes truth and rewrites only the rows that disagree, nightly.
//
// ── THE SHAPE: BOUNDED READ PAGES, THEN SMALL GUARDED WRITES ───────────────────────────────
//
// Truth is an aggregate over the growing `tracks` / `track_artists` graph, so it is NEVER computed
// inside a write transaction: one transaction that aggregates the whole graph holds the single
// libSQL writer for as long as the aggregate runs, and that time grows linearly with the archive.
// Instead, per entity table, in `id` order:
//
// 1. THE PAGE READ. One read statement takes the next `HUB_COUNTS_RECONCILE_PAGE_SIZE` entity rows
//    after the keyset cursor (`id > ?`, the primary-key autoindex) and LEFT JOINs each to its own
//    tracks by the entity's per-id index (`tracks_label_id_idx` / `tracks_album_id_idx` /
//    `track_artists_artist_id_idx`). It returns every page row's STORED counters beside its TRUTH
//    from the same snapshot. Its cost is bounded by the page's own track mass, never the archive.
//    An entity with no tracks gets zero truth from the LEFT JOIN, so the stale-nonzero case (an
//    entity whose last track was deleted out of band) needs no second pass.
//
// 2. THE GUARDED WRITE. Only rows whose stored counters differ from truth are written, each as a
//    primary-key compare-and-set: `update … set <truth> where id = ? and <every counter> = <the
//    value the page read>`. At most one page of corrections rides one write batch (a correction
//    plus its due-work marker is two statements, so a 250-row page is at most 500 statements, the
//    shared due-work chunk bound), and every statement is a point write: the batch never scans.
//
// ── WHY COMPARE-AND-SET ────────────────────────────────────────────────────────────────────
//
// Every maintained edge writer applies its delta in the same transaction as its edge write, so
// between any two snapshots `stored − truth` is unchanged by correct traffic. The guard makes a
// correction apply only when the counters still hold the value the page read, and in that case
// truth still equals what the page computed, so the write is exactly the old single-statement
// correction. If a delta landed in between, the guard matches no row and the delta survives. The
// page is then read once more and corrected from that fresher snapshot; a row whose guard loses
// again is reported as `deferred` and left for the next pass rather than overwritten.
//
// `corrected` is the number of rows whose guarded write actually changed them, so a clean archive
// reports zero and a non-zero reading remains the drift signal the operator audits. The due-work
// source marker is appended only when its correction changed a row (`changes() > 0`), and the
// producer ids keep their meaning: `-grouped` for an entity that still has tracks, `-zero` for one
// corrected to zero.
//
// ── THE PINNED ARTISTS SOURCE ──────────────────────────────────────────────────────────────
//
// Artist truth joins `track_artists` to `tracks` and counts only edges whose track exists
// (`count(t.track_id)`), never raw edges. Production carries ORPHANED edges left by out-of-band
// track deletion, and the hub read paths all join `tracks`; counting raw edges would "correct" the
// counters into disagreeing with what actually RENDERS.
//
// `certified` keys off `tracks.is_catalogue = 0` (keystone 1's materialized discriminator), never
// a `findings` join — the same rule the write side follows, so truth here means the same thing
// truth means there.
//
// ── WINDOWS ────────────────────────────────────────────────────────────────────────────────
//
// A call processes at most `pageLimit` pages across the tables in `labels → albums → artists`
// order and returns the cursor to resume from (`next`, null once every table is done). The nightly
// box sweep runs one bounded window per admitted database phase, so the admission lease is held
// only while a window runs. A call with neither a cursor nor a page limit runs every page in one
// request: the manual trigger, still built from the same bounded statements.

import { type InStatement } from "@libsql/client";

import { getDb, typedRows } from "./db";
import {
  batchDueWorkMutationGroups,
  dueWorkSourceMutationStatements,
  MAX_DUE_WORK_CHUNK_SIZE,
} from "./due-work";

/** Entity rows per keyset page. Two statements per correction keep a page inside one chunk. */
export const HUB_COUNTS_RECONCILE_PAGE_SIZE = MAX_DUE_WORK_CHUNK_SIZE / 2;

/** Pages a windowed call processes when it names a cursor but no page limit. */
export const HUB_COUNTS_RECONCILE_DEFAULT_WINDOW_PAGES = 8;

/** The entity tables, in the order a pass walks and reports them. */
export const HUB_COUNTS_RECONCILE_TABLES = ["labels", "albums", "artists"] as const;

export type HubCountsReconcileTable = (typeof HUB_COUNTS_RECONCILE_TABLES)[number];

/** Where a windowed pass resumes: the table, and the last entity id already reconciled in it. */
export type HubCountsReconcileCursor = {
  afterId: null | string;
  table: HubCountsReconcileTable;
};

/** One table's reconciliation outcome for the pages this call processed. */
export type HubCountsTableResult = {
  /** Entity rows whose stored counters disagreed with truth and were rewritten. */
  corrected: number;
  /** Drifted rows whose guarded write lost to a concurrent counter move twice; the next pass owns them. */
  deferred: number;
};

/** What one reconciliation call reports. */
export type HubCountsReconcileResult = {
  albums: HubCountsTableResult;
  artists: HubCountsTableResult;
  labels: HubCountsTableResult;
  /** The cursor to resume from, or null once every table has been reconciled. */
  next: HubCountsReconcileCursor | null;
  /** Keyset pages processed (a page re-read after a lost guard counts once). */
  pages: number;
  /** Wall-clock milliseconds the call took, server-side. */
  tookMs: number;
};

export type HubCountsReconcileOptions = {
  /** Resume point; absent starts at the first label. */
  cursor?: HubCountsReconcileCursor;
  /** Pages to process; absent runs every page when no cursor is given. */
  pageLimit?: number;
  /** Entity rows per page. Tests shrink it to cross page boundaries on small fixtures. */
  pageSize?: number;
};

/** One page row: the stored counters and the truth, read from one snapshot. */
type PageRow = {
  certified: number;
  id: string;
  rankable: number;
  renderable: number;
  storedCertified: number;
  storedRankable: number;
  storedRenderable: number;
};

type RawPageRow = {
  certified: bigint | number | null;
  id: string;
  rankable: bigint | number | null;
  renderable: bigint | number | null;
  stored_certified: bigint | number | null;
  stored_rankable: bigint | number | null;
  stored_renderable: bigint | number | null;
};

type PageOutcome = {
  corrected: number;
  deferred: number;
  lastId: null | string;
  rowCount: number;
};

/**
 * The page read. Entity ids are never blank (the due-work marker rejects a blank subject id), so
 * the first page starts at `id > ''`.
 */
function pageStatement(
  table: HubCountsReconcileTable,
  afterId: null | string,
  pageSize: number,
): InStatement {
  const args = [afterId ?? "", pageSize];

  if (table === "artists") {
    return {
      args,
      sql: `with page as (
              select id, renderable_track_count, certified_finding_count, rankable_track_count
              from artists
              where id > ?
              order by id
              limit ?
            )
            select page.id as id,
                   page.renderable_track_count as stored_renderable,
                   page.certified_finding_count as stored_certified,
                   page.rankable_track_count as stored_rankable,
                   count(t.track_id) as renderable,
                   coalesce(sum(case when t.is_catalogue = 0 then 1 else 0 end), 0) as certified,
                   coalesce(sum(case when t.key is not null and t.has_embedding = 1 then 1 else 0 end), 0)
                     as rankable
            from page
            left join track_artists ta on ta.artist_id = page.id
            left join tracks t on t.track_id = ta.track_id
            group by page.id
            order by page.id`,
    };
  }

  const foreignKey = table === "labels" ? "label_id" : "album_id";

  return {
    args,
    sql: `with page as (
            select id, renderable_track_count, certified_finding_count
            from ${table}
            where id > ?
            order by id
            limit ?
          )
          select page.id as id,
                 page.renderable_track_count as stored_renderable,
                 page.certified_finding_count as stored_certified,
                 0 as stored_rankable,
                 count(tracks.track_id) as renderable,
                 coalesce(sum(case when tracks.is_catalogue = 0 then 1 else 0 end), 0) as certified,
                 0 as rankable
          from page
          left join tracks on tracks.${foreignKey} = page.id
          group by page.id
          order by page.id`,
  };
}

async function readPage(
  table: HubCountsReconcileTable,
  afterId: null | string,
  pageSize: number,
): Promise<PageRow[]> {
  const db = await getDb();
  const result = await db.execute(pageStatement(table, afterId, pageSize));

  return typedRows<RawPageRow>(result.rows).map((row) => ({
    certified: Number(row.certified ?? 0),
    id: String(row.id),
    rankable: Number(row.rankable ?? 0),
    renderable: Number(row.renderable ?? 0),
    storedCertified: Number(row.stored_certified ?? 0),
    storedRankable: Number(row.stored_rankable ?? 0),
    storedRenderable: Number(row.stored_renderable ?? 0),
  }));
}

function isDrifted(table: HubCountsReconcileTable, row: PageRow): boolean {
  return (
    row.storedRenderable !== row.renderable ||
    row.storedCertified !== row.certified ||
    (table === "artists" && row.storedRankable !== row.rankable)
  );
}

/**
 * Write one page's corrections as guarded point writes. Returns the ids whose guard matched no
 * row: a concurrent maintained delta moved their counters after the page read them.
 */
async function writeCorrections(
  table: HubCountsReconcileTable,
  rows: readonly PageRow[],
): Promise<{ corrected: number; lost: string[] }> {
  const drifted = rows.filter((row) => isDrifted(table, row));
  if (drifted.length === 0) {
    return { corrected: 0, lost: [] };
  }

  const groups: InStatement[][] = [];

  for (const row of drifted) {
    const stillLinked = row.renderable > 0;

    if (table === "labels") {
      groups.push(
        dueWorkSourceMutationStatements(
          [
            {
              args: [
                row.renderable,
                row.certified,
                row.id,
                row.storedRenderable,
                row.storedCertified,
              ],
              sql: `update labels
                    set renderable_track_count = ?, certified_finding_count = ?
                    where id = ? and renderable_track_count = ? and certified_finding_count = ?`,
            },
          ],
          [{ subjectId: row.id, subjectType: "label" }],
          stillLinked
            ? {
                onlyIfLastSourceStatementChanged: true,
                producer: "hub-counts-reconcile-label-grouped",
              }
            : {
                onlyIfLastSourceStatementChanged: true,
                producer: "hub-counts-reconcile-label-zero",
              },
        ),
      );
    } else if (table === "albums") {
      groups.push(
        dueWorkSourceMutationStatements(
          [
            {
              args: [
                row.renderable,
                row.certified,
                row.id,
                row.storedRenderable,
                row.storedCertified,
              ],
              sql: `update albums
                    set renderable_track_count = ?, certified_finding_count = ?
                    where id = ? and renderable_track_count = ? and certified_finding_count = ?`,
            },
          ],
          [{ subjectId: row.id, subjectType: "album" }],
          stillLinked
            ? {
                onlyIfLastSourceStatementChanged: true,
                producer: "hub-counts-reconcile-album-grouped",
              }
            : {
                onlyIfLastSourceStatementChanged: true,
                producer: "hub-counts-reconcile-album-zero",
              },
        ),
      );
    } else {
      groups.push(
        dueWorkSourceMutationStatements(
          [
            {
              args: [
                row.renderable,
                row.certified,
                row.rankable,
                row.id,
                row.storedRenderable,
                row.storedCertified,
                row.storedRankable,
              ],
              sql: `update artists
                    set renderable_track_count = ?, certified_finding_count = ?, rankable_track_count = ?
                    where id = ? and renderable_track_count = ? and certified_finding_count = ?
                      and rankable_track_count = ?`,
            },
          ],
          [{ subjectId: row.id, subjectType: "artist" }],
          stillLinked
            ? {
                onlyIfLastSourceStatementChanged: true,
                producer: "hub-counts-reconcile-artist-grouped",
              }
            : {
                onlyIfLastSourceStatementChanged: true,
                producer: "hub-counts-reconcile-artist-zero",
              },
        ),
      );
    }
  }

  const db = await getDb();
  const results = await batchDueWorkMutationGroups(db, groups, MAX_DUE_WORK_CHUNK_SIZE);
  let corrected = 0;
  const lost: string[] = [];

  results.forEach((group, index) => {
    if ((group[0]?.rowsAffected ?? 0) > 0) {
      corrected += 1;
      return;
    }
    const row = drifted[index];
    if (row !== undefined) {
      lost.push(row.id);
    }
  });

  return { corrected, lost };
}

/** Reconcile one keyset page, re-reading it once when a guarded write lost to a concurrent delta. */
async function reconcilePage(
  table: HubCountsReconcileTable,
  afterId: null | string,
  pageSize: number,
): Promise<PageOutcome> {
  let rows = await readPage(table, afterId, pageSize);
  const first = await writeCorrections(table, rows);
  let corrected = first.corrected;
  let deferred = 0;

  if (first.lost.length > 0) {
    // The same keyset bounds, read again: the lost rows now carry the moved counters and the truth
    // that moved with them. Rows corrected by the first write already agree and are not rewritten.
    rows = await readPage(table, afterId, pageSize);
    const retry = await writeCorrections(table, rows);
    corrected += retry.corrected;
    deferred = retry.lost.length;
  }

  return { corrected, deferred, lastId: rows.at(-1)?.id ?? null, rowCount: rows.length };
}

function nextTable(table: HubCountsReconcileTable): HubCountsReconcileTable | null {
  const index = HUB_COUNTS_RECONCILE_TABLES.indexOf(table);

  return HUB_COUNTS_RECONCILE_TABLES[index + 1] ?? null;
}

/**
 * Reconcile hub counts over at most `pageLimit` keyset pages and report how many rows each table
 * had to correct. Idempotent by construction: on a healthy archive every page reads clean, no write
 * batch runs, and a re-run reports `{ corrected: 0, deferred: 0 }` across the board.
 *
 * Each page's corrections commit independently, so a later failure preserves earlier progress, and
 * each correction commits with its due-work marker.
 */
export async function reconcileHubCounts(
  options: HubCountsReconcileOptions = {},
): Promise<HubCountsReconcileResult> {
  const started = Date.now();
  const pageSize = options.pageSize ?? HUB_COUNTS_RECONCILE_PAGE_SIZE;
  const pageLimit =
    options.pageLimit ??
    (options.cursor === undefined
      ? Number.POSITIVE_INFINITY
      : HUB_COUNTS_RECONCILE_DEFAULT_WINDOW_PAGES);

  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > HUB_COUNTS_RECONCILE_PAGE_SIZE
  ) {
    throw new Error(
      `hub-count reconcile pages hold 1 through ${HUB_COUNTS_RECONCILE_PAGE_SIZE} rows`,
    );
  }
  if (!(pageLimit >= 1)) {
    throw new Error("hub-count reconcile windows process at least one page");
  }

  const totals: Record<HubCountsReconcileTable, HubCountsTableResult> = {
    albums: { corrected: 0, deferred: 0 },
    artists: { corrected: 0, deferred: 0 },
    labels: { corrected: 0, deferred: 0 },
  };
  let cursor: HubCountsReconcileCursor | null = options.cursor ?? {
    afterId: null,
    table: "labels",
  };
  let pages = 0;

  while (cursor !== null && pages < pageLimit) {
    const page = await reconcilePage(cursor.table, cursor.afterId, pageSize);
    const tableTotals = totals[cursor.table];
    tableTotals.corrected += page.corrected;
    tableTotals.deferred += page.deferred;
    pages += 1;

    if (page.rowCount === pageSize && page.lastId !== null) {
      cursor = { afterId: page.lastId, table: cursor.table };
      continue;
    }

    const table = nextTable(cursor.table);
    cursor = table === null ? null : { afterId: null, table };
  }

  return {
    albums: totals.albums,
    artists: totals.artists,
    labels: totals.labels,
    next: cursor,
    pages,
    tookMs: Date.now() - started,
  };
}
