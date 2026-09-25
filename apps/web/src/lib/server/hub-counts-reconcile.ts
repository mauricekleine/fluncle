import { type InStatement } from "@libsql/client";

import { getDb, typedRows } from "./db";
import { releaseTodayUtc, validReleaseDateSql } from "./release-day";
import {
  batchDueWorkMutationGroups,
  dueWorkSourceMutationStatements,
  MAX_DUE_WORK_CHUNK_SIZE,
} from "./due-work";

export const HUB_COUNTS_RECONCILE_PAGE_SIZE = MAX_DUE_WORK_CHUNK_SIZE / 2;

export const HUB_COUNTS_RECONCILE_DEFAULT_WINDOW_PAGES = 8;

export const HUB_COUNTS_RECONCILE_TABLES = ["labels", "albums", "artists"] as const;

export type HubCountsReconcileTable = (typeof HUB_COUNTS_RECONCILE_TABLES)[number];

export type HubCountsReconcileCursor = {
  afterId: null | string;
  table: HubCountsReconcileTable;
};

export type HubCountsTableResult = {
  corrected: number;

  deferred: number;
  latestCorrected: number;
};

export type HubCountsReconcileResult = {
  albums: HubCountsTableResult;
  artists: HubCountsTableResult;
  labels: HubCountsTableResult;

  next: HubCountsReconcileCursor | null;

  pages: number;

  tookMs: number;
};

export type HubCountsReconcileOptions = {
  cursor?: HubCountsReconcileCursor;

  pageLimit?: number;

  pageSize?: number;
};

type PageRow = {
  certified: number;
  id: string;
  rankable: number;
  renderable: number;
  storedCertified: number;
  storedRankable: number;
  storedRenderable: number;
  latest: null | string;
  storedLatest: null | string;
};

type RawPageRow = {
  certified: bigint | number | null;
  id: string;
  rankable: bigint | number | null;
  renderable: bigint | number | null;
  stored_certified: bigint | number | null;
  stored_rankable: bigint | number | null;
  stored_renderable: bigint | number | null;
  latest: null | string;
  stored_latest: null | string;
};

type PageOutcome = {
  corrected: number;
  latestCorrected: number;
  deferred: number;
  lastId: null | string;
  rowCount: number;
};

function pageStatement(
  table: HubCountsReconcileTable,
  afterId: null | string,
  pageSize: number,
  today: string,
): InStatement {
  const args = [afterId ?? "", pageSize, today];

  if (table === "artists") {
    return {
      args,
      sql: `with page as (
              select id, renderable_track_count, certified_finding_count, rankable_track_count, latest_release_date
              from artists
              where id > ?
              order by id
              limit ?
            )
            select page.id as id,
                   page.renderable_track_count as stored_renderable,
                   page.certified_finding_count as stored_certified,
                   page.rankable_track_count as stored_rankable,
                   page.latest_release_date as stored_latest,
                   max(case when ${validReleaseDateSql("t.release_date")} and t.release_date <= ? and t.dismissed_at is null and t.duplicate_of_track_id is null then t.release_date end) as latest,
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
            select id, renderable_track_count, certified_finding_count, latest_release_date
            from ${table}
            where id > ?
            order by id
            limit ?
          )
          select page.id as id,
                 page.renderable_track_count as stored_renderable,
                 page.certified_finding_count as stored_certified,
                 0 as stored_rankable,
                 page.latest_release_date as stored_latest,
                 max(case when ${validReleaseDateSql("tracks.release_date")} and tracks.release_date <= ? and tracks.dismissed_at is null and tracks.duplicate_of_track_id is null then tracks.release_date end) as latest,
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
  today: string,
): Promise<PageRow[]> {
  const db = await getDb();
  const result = await db.execute(pageStatement(table, afterId, pageSize, today));

  return typedRows<RawPageRow>(result.rows).map((row) => ({
    certified: Number(row.certified ?? 0),
    id: String(row.id),
    latest: row.latest,
    rankable: Number(row.rankable ?? 0),
    renderable: Number(row.renderable ?? 0),
    storedCertified: Number(row.stored_certified ?? 0),
    storedLatest: row.stored_latest,
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

async function writeLatestCorrections(
  table: HubCountsReconcileTable,
  rows: readonly PageRow[],
): Promise<{ latestCorrected: number; lost: string[] }> {
  const drifted = rows.filter((row) => row.latest !== row.storedLatest);
  if (drifted.length === 0) {
    return { latestCorrected: 0, lost: [] };
  }
  const db = await getDb();
  const results = await db.batch(
    drifted.map((row) => ({
      args: [row.latest, row.id, row.storedLatest],
      sql: `update ${table} set latest_release_date = ? where id = ? and latest_release_date is ?`,
    })),
    "write",
  );
  return {
    latestCorrected: results.filter((result) => result.rowsAffected > 0).length,
    lost: drifted.flatMap((row, index) =>
      (results[index]?.rowsAffected ?? 0) > 0 ? [] : [row.id],
    ),
  };
}

async function reconcilePage(
  table: HubCountsReconcileTable,
  afterId: null | string,
  pageSize: number,
  today: string,
): Promise<PageOutcome> {
  let rows = await readPage(table, afterId, pageSize, today);
  const first = await writeCorrections(table, rows);
  const firstLatest = await writeLatestCorrections(table, rows);
  let corrected = first.corrected;
  let latestCorrected = firstLatest.latestCorrected;
  let deferred = 0;

  if (first.lost.length > 0 || firstLatest.lost.length > 0) {
    rows = await readPage(table, afterId, pageSize, today);
    const retry = await writeCorrections(table, rows);
    const retryLatest = await writeLatestCorrections(table, rows);
    corrected += retry.corrected;
    latestCorrected += retryLatest.latestCorrected;
    deferred = new Set([...retry.lost, ...retryLatest.lost]).size;
  }

  return {
    corrected,
    deferred,
    lastId: rows.at(-1)?.id ?? null,
    latestCorrected,
    rowCount: rows.length,
  };
}

function nextTable(table: HubCountsReconcileTable): HubCountsReconcileTable | null {
  const index = HUB_COUNTS_RECONCILE_TABLES.indexOf(table);

  return HUB_COUNTS_RECONCILE_TABLES[index + 1] ?? null;
}

export async function reconcileHubCounts(
  options: HubCountsReconcileOptions = {},
): Promise<HubCountsReconcileResult> {
  const started = Date.now();
  const today = releaseTodayUtc(new Date());
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
    albums: { corrected: 0, deferred: 0, latestCorrected: 0 },
    artists: { corrected: 0, deferred: 0, latestCorrected: 0 },
    labels: { corrected: 0, deferred: 0, latestCorrected: 0 },
  };
  let cursor: HubCountsReconcileCursor | null = options.cursor ?? {
    afterId: null,
    table: "labels",
  };
  let pages = 0;

  while (cursor !== null && pages < pageLimit) {
    const page = await reconcilePage(cursor.table, cursor.afterId, pageSize, today);
    const tableTotals = totals[cursor.table];
    tableTotals.corrected += page.corrected;
    tableTotals.latestCorrected += page.latestCorrected;
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
