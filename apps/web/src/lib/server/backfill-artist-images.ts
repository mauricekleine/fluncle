// Artist-avatar backfill: for existing artists minted before the `image_url` column,
// fetch the largest Spotify profile image and stamp it onto `artists.image_url`.
//
// Mirrors the artist-entity backfill (backfill-artists.ts):
//   - One bounded, cursor-resumable pass per request (MAX_BATCH artists).
//   - Only PENDING artists still missing an image AND carrying a Spotify id are
//     eligible. A genuine Spotify no-image response is terminal `none`; failures
//     and shared-budget deferrals remain pending.
//   - Spotify only permits this app's per-id `/v1/artists/{id}` path. The shared
//     call meter stops a pass before it crowds out user-facing Spotify work.
//
// The create path (`upsertTrackArtists` → `fillMissingArtistImages`) covers every
// artist minted from here on; this backfill catches the ~70 that predate the column.
// The on-box `fluncle-artist-sweep` cron drains it a page per tick; the CLI
// (`fluncle admin backfills artist-images`) loops the cursor for an ad-hoc run.

import { fetchArtistImages } from "./spotify";
import { getDb, typedRow, typedRows } from "./db";
import { batchDueWorkSourceMutation } from "./due-work";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";

// Keep the DB page bounded even though the per-id call meter normally pauses a
// fresh-window pass after at most 24 lookups.
const MAX_BATCH = 50;

type BackfillRow = {
  id: string;
  spotify_artist_id: string;
};

function artistImageContinuation(
  cursor: string | undefined,
): { sortKey: string; subjectId: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  return {
    sortKey: encodeDueWorkOrder([{ direction: "asc", kind: "text", value: cursor }]),
    subjectId: cursor,
  };
}

function restoreArtistImageOrder(
  rows: BackfillRow[],
  subjectIds: readonly string[],
): BackfillRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return subjectIds.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}

export type ArtistImagesBackfillResult = {
  budgetLimited: boolean;
  checkedCount: number;
  dryRun: boolean;
  failed: Array<{ artistId: string; error: string }>;
  failedCount: number;
  filled: string[];
  filledCount: number;
  nextCursor: string | null;
  ok: boolean;
  queueDepth: number;
  rateLimited: boolean;
  skipped: string[];
  skippedCount: number;
};

export async function backfillArtistImages(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistImagesBackfillResult> {
  const db = await getDb();
  const batchLimit = Math.min(Math.max(1, limit), MAX_BATCH);
  const dueCutoverEnabled = await isDueWorkCutoverEnabled();

  let rows: BackfillRow[];

  if (dueCutoverEnabled) {
    const page = await readPromotedDueWorkPage(db, "artist.image", {
      continuation: artistImageContinuation(cursor),
      limit: batchLimit,
    });

    if (page.subjectIds.length === 0) {
      rows = [];
    } else {
      const placeholders = page.subjectIds.map(() => "?").join(", ");
      const result = await db.execute({
        args: page.subjectIds,
        sql: `select id, spotify_artist_id from artists
              where id in (${placeholders})`,
      });
      rows = restoreArtistImageOrder(typedRows<BackfillRow>(result.rows), page.subjectIds);
    }
  } else {
    // GOAL H CONTRACTION: this is the unchanged source-table selector retained while Goal C's
    // default-off cutover proves the due_work projection.
    rows = typedRows<BackfillRow>(
      (
        await db.execute({
          args: cursor ? [cursor, batchLimit] : [batchLimit],
          sql: cursor
            ? `select id, spotify_artist_id from artists
               where image_url is null
                 and spotify_artist_id is not null
                 and image_state = 'pending'
                 and id > ?
               order by id asc limit ?`
            : `select id, spotify_artist_id from artists
               where image_url is null
                 and spotify_artist_id is not null
                 and image_state = 'pending'
               order by id asc limit ?`,
        })
      ).rows,
    );
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ artistId: string; error: string }> = [];
  const lastId = rows.at(-1)?.id;
  let budgetLimited = false;
  let checkedCount = 0;
  let rateLimited = false;

  if (dryRun) {
    for (const row of rows) {
      filled.push(row.id);
    }
    checkedCount = rows.length;
  } else if (rows.length > 0) {
    try {
      const result = await fetchArtistImages(rows.map((row) => row.spotify_artist_id));
      const nowIso = new Date().toISOString();

      budgetLimited = result.budgetLimited;
      checkedCount = result.checkedCount;
      rateLimited = result.rateLimited;

      for (const row of rows) {
        const url = result.images.get(row.spotify_artist_id);

        if (url) {
          // Keep image_state pending: the downstream owned-master sweep still has to
          // ingest this Spotify source into Fluncle's R2.
          await batchDueWorkSourceMutation(
            db,
            [
              {
                args: [url, nowIso, row.id],
                sql: `update artists
                      set image_url = ?, updated_at = ?
                      where id = ? and image_url is null and image_state = 'pending'`,
              },
            ],
            [{ subjectId: row.id, subjectType: "artist" }],
            { onlyIfLastSourceStatementChanged: true, producer: "artist-image-backfill-fill" },
          );
          filled.push(row.id);
          continue;
        }

        if (result.missingIds.has(row.spotify_artist_id)) {
          // A matching 200 response with no usable image is a terminal verdict. It
          // also removes the row from the owned-master sweep's pending source queue.
          await batchDueWorkSourceMutation(
            db,
            [
              {
                args: [nowIso, row.id],
                sql: `update artists
                      set image_state = 'none', image_attempted_at = ?, image_failures = 0
                      where id = ? and image_url is null and image_state = 'pending'`,
              },
            ],
            [{ subjectId: row.id, subjectType: "artist" }],
            { onlyIfLastSourceStatementChanged: true, producer: "artist-image-backfill-none" },
          );
          skipped.push(row.id);
          continue;
        }

        const failure = result.failures.get(row.spotify_artist_id);

        if (failure) {
          failed.push({ artistId: row.id, error: failure });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      for (const row of rows) {
        failed.push({ artistId: row.id, error: message });
      }
    }
  }

  // `queueDepth` is an exact public/CLI contract, so it is the explicit exception to replacing
  // corpus counts with projection probes during Goal C. Producer retirement is not in this slice;
  // a projection count or page sentinel would report stale/inexact work after the writes above.
  const queueDepthRow = typedRow<{ queue_depth: number }>(
    (
      await db.execute({
        args: [],
        sql: `select count(*) as queue_depth from artists
              where image_url is null
                and spotify_artist_id is not null
                and image_state = 'pending'`,
      })
    ).rows,
  );
  const queueDepth = Number(queueDepthRow?.queue_depth ?? 0);

  // Drained when the page came back short of the batch cap.
  const nextCursor =
    rateLimited || budgetLimited ? null : rows.length === batchLimit ? (lastId ?? null) : null;

  return {
    budgetLimited,
    checkedCount,
    dryRun,
    failed,
    failedCount: failed.length,
    filled,
    filledCount: filled.length,
    nextCursor,
    ok: true,
    queueDepth,
    rateLimited,
    skipped,
    skippedCount: skipped.length,
  };
}
