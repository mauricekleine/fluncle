import { getDb, typedRows } from "./db";
import {
  batchDueWorkSourceMutation,
  markDueWorkSourceMaintenanceFromSelectStatements,
} from "./due-work";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import { FILL_ISRC_SQL } from "./isrc";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";
import { updateTrackDuplicateIsrcStatement } from "./track-duplicate-keys";

const CRAWLER_TRACK_ID_PREFIX = "mb_";

const PREFIX_STRIP_BATCH = 500;

const MAX_API_BATCH = 25;

const ISRC_REFRESH_AFTER_DAYS = 21;

const MAX_ISRC_REFRESH_BATCH = 25;

export function recordingMbidFromTrackId(trackId: string): string | null {
  return trackId.startsWith(CRAWLER_TRACK_ID_PREFIX)
    ? trackId.slice(CRAWLER_TRACK_ID_PREFIX.length)
    : null;
}

type ResolveOutcome =
  | { kind: "resolved"; mbid: string }
  | { kind: "missed" }
  | { kind: "failed"; error: string }
  | { kind: "rate-limited" };

export type RecordingMbidsResolveResult = {
  dryRun: boolean;
  isrcRefreshMissed: string[];
  isrcRefreshMissedCount: number;
  isrcRefreshed: string[];
  isrcRefreshedCount: number;
  prefixStripped: number;
  resolved: string[];
  resolvedCount: number;
  missed: string[];
  missedCount: number;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  nextCursor: string | null;
  rateLimited: boolean;
};

type MbIsrcResponse = { recordings?: { id?: string }[] };

async function resolveRecordingMbidByIsrc(
  isrc: string,
): Promise<{ mbid: string | null; rateLimited: boolean }> {
  const { data, rateLimited } = await mbFetch<MbIsrcResponse>(`/isrc/${encodeURIComponent(isrc)}`);

  if (rateLimited) {
    return { mbid: null, rateLimited: true };
  }

  const mbid = data?.recordings?.find((recording) => recording.id)?.id ?? null;

  return { mbid, rateLimited: false };
}

type MbRecordingIsrcsResponse = { isrcs?: string[] };

async function refreshIsrcByRecordingMbid(
  mbid: string,
): Promise<{ isrc: string | null; rateLimited: boolean }> {
  const { data, rateLimited } = await mbFetch<MbRecordingIsrcsResponse>(
    `/recording/${encodeURIComponent(mbid)}?inc=isrcs`,
  );

  if (rateLimited) {
    return { isrc: null, rateLimited: true };
  }

  const isrc = data?.isrcs?.find((value) => value.trim())?.trim() ?? null;

  return { isrc, rateLimited: false };
}

type IsrcWorkRow = { isrc: string; track_id: string };

type IsrcRefreshRow = { mb_recording_id: string; track_id: string };

async function stripCrawlerPrefixes(): Promise<number> {
  const db = await getDb();

  const source = {
    args: [CRAWLER_TRACK_ID_PREFIX, PREFIX_STRIP_BATCH],
    sql: `select track_id as subject_id from tracks indexed by tracks_mb_recording_id_queue_idx
          where mb_recording_id is null
            and mb_recording_id_attempted_at is null
            and substr(track_id, 1, 3) = ?
          order by track_id asc
          limit ?`,
  };
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements("track", source, {
        producer: "recording-mbid-prefix-strip",
      }),
      {
        args: [CRAWLER_TRACK_ID_PREFIX, PREFIX_STRIP_BATCH],
        sql: `update tracks
              set mb_recording_id = substr(track_id, 4)
              where track_id in (
                select track_id from tracks indexed by tracks_mb_recording_id_queue_idx
                where mb_recording_id is null
                  and mb_recording_id_attempted_at is null
                  and substr(track_id, 1, 3) = ?
                order by track_id asc
                limit ?
              )`,
      },
    ],
    "write",
  );
  const result = results.at(-1);

  return result?.rowsAffected ?? 0;
}

async function projectedStrippableCrawlerIds(
  db: Awaited<ReturnType<typeof getDb>>,
  trackIds: readonly string[],
): Promise<string[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const result = await db.execute({
    args: [...trackIds, CRAWLER_TRACK_ID_PREFIX],
    sql: `select track_id from tracks
          where track_id in (${trackIds.map(() => "?").join(", ")})
            and mb_recording_id is null
            and mb_recording_id_attempted_at is null
            and substr(track_id, 1, 3) = ?`,
  });
  const eligible = new Set(typedRows<{ track_id: string }>(result.rows).map((row) => row.track_id));

  return trackIds.filter((trackId) => eligible.has(trackId));
}

async function stripProjectedCrawlerPrefixes(
  db: Awaited<ReturnType<typeof getDb>>,
  trackIds: readonly string[],
): Promise<number> {
  if (trackIds.length === 0) {
    return 0;
  }

  const [result] = await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [...trackIds, CRAWLER_TRACK_ID_PREFIX],
        sql: `update tracks
              set mb_recording_id = substr(track_id, 4)
              where track_id in (${trackIds.map(() => "?").join(", ")})
                and mb_recording_id is null
                and mb_recording_id_attempted_at is null
                and substr(track_id, 1, 3) = ?`,
      },
    ],
    trackIds.map((subjectId) => ({ subjectId, subjectType: "track" })),
    { producer: "recording-mbid-prefix-strip" },
  );

  return result?.rowsAffected ?? 0;
}

async function countStrippableCrawlerRows(): Promise<number> {
  const db = await getDb();

  const result = await db.execute({
    args: [PREFIX_STRIP_BATCH],
    sql: `select count(*) as n from (
            select track_id from tracks indexed by tracks_mb_recording_id_queue_idx
            where mb_recording_id is null
              and mb_recording_id_attempted_at is null
              and substr(track_id, 1, 3) = 'mb_'
            limit ?
          )`,
  });

  return typedRows<{ n: number }>(result.rows)[0]?.n ?? 0;
}

async function listIsrcWork(limit: number, cursor: string | undefined): Promise<IsrcWorkRow[]> {
  const db = await getDb();

  const result = await db.execute({
    args: cursor ? [cursor, limit] : [limit],
    sql: cursor
      ? `select track_id, isrc from tracks indexed by tracks_mb_recording_id_queue_idx
         where mb_recording_id is null
           and mb_recording_id_attempted_at is null
           and isrc is not null and isrc != ''
           and substr(track_id, 1, 3) != 'mb_'
           and track_id > ?
         order by track_id asc limit ?`
      : `select track_id, isrc from tracks indexed by tracks_mb_recording_id_queue_idx
         where mb_recording_id is null
           and mb_recording_id_attempted_at is null
           and isrc is not null and isrc != ''
           and substr(track_id, 1, 3) != 'mb_'
         order by track_id asc limit ?`,
  });

  return typedRows<IsrcWorkRow>(result.rows);
}

async function hydrateIsrcWork(trackIds: readonly string[]): Promise<IsrcWorkRow[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...trackIds],
    sql: `select track_id, isrc from tracks
          where track_id in (${trackIds.map(() => "?").join(", ")})`,
  });
  const byId = new Map(typedRows<IsrcWorkRow>(result.rows).map((row) => [row.track_id, row]));

  return trackIds.flatMap((trackId) => {
    const row = byId.get(trackId);
    return row === undefined ? [] : [row];
  });
}

async function markResolved(trackId: string, mbid: string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [mbid, new Date().toISOString(), trackId],
        sql: `update tracks
              set mb_recording_id = coalesce(mb_recording_id, ?), mb_recording_id_attempted_at = ?
              where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "recording-mbid-resolved" },
  );
}

async function listIsrcRefreshWork(limit: number, cutoff: string): Promise<IsrcRefreshRow[]> {
  const db = await getDb();

  const result = await db.execute({
    args: [cutoff, limit],
    sql: `select track_id, mb_recording_id from tracks
          where mb_recording_id is not null
            and (isrc is null or trim(isrc) = '')
            and (isrc_attempted_at is null or isrc_attempted_at < ?)
          order by isrc_attempted_at asc, track_id asc
          limit ?`,
  });

  return typedRows<IsrcRefreshRow>(result.rows);
}

async function hydrateIsrcRefreshWork(trackIds: readonly string[]): Promise<IsrcRefreshRow[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...trackIds],
    sql: `select track_id, mb_recording_id from tracks
          where track_id in (${trackIds.map(() => "?").join(", ")})`,
  });
  const byId = new Map(typedRows<IsrcRefreshRow>(result.rows).map((row) => [row.track_id, row]));

  return trackIds.flatMap((trackId) => {
    const row = byId.get(trackId);
    return row === undefined ? [] : [row];
  });
}

async function markIsrcRefreshed(trackId: string, isrc: null | string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [isrc, isrc, new Date().toISOString(), trackId],
        sql: `update tracks
              set ${FILL_ISRC_SQL}, isrc_attempted_at = ?
              where track_id = ?`,
      },
      updateTrackDuplicateIsrcStatement(trackId, isrc),
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "recording-isrc-refresh" },
  );
}

async function markMissed(trackId: string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [new Date().toISOString(), trackId],
        sql: `update tracks set mb_recording_id_attempted_at = ? where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "recording-mbid-missed" },
  );
}

async function resolveIsrcRows(
  rows: IsrcWorkRow[],
  dryRun: boolean,
): Promise<{
  failed: Array<{ error: string; trackId: string }>;
  missed: string[];
  rateLimited: boolean;
  resolved: string[];
}> {
  const resolved: string[] = [];
  const missed: string[] = [];
  const failed: Array<{ error: string; trackId: string }> = [];
  let rateLimited = false;

  if (dryRun) {
    return { failed, missed, rateLimited, resolved: rows.map((row) => row.track_id) };
  }

  for (const row of rows) {
    let outcome: ResolveOutcome;
    try {
      const { mbid, rateLimited: throttled } = await resolveRecordingMbidByIsrc(row.isrc);
      outcome = throttled
        ? { kind: "rate-limited" }
        : mbid
          ? { kind: "resolved", mbid }
          : { kind: "missed" };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error), kind: "failed" };
    }

    if (outcome.kind === "rate-limited") {
      rateLimited = true;
      break;
    }
    if (outcome.kind === "resolved") {
      await markResolved(row.track_id, outcome.mbid);
      logEvent("info", "recording-mbids.resolved", { mbid: outcome.mbid, trackId: row.track_id });
      resolved.push(row.track_id);
      continue;
    }
    if (outcome.kind === "missed") {
      await markMissed(row.track_id);
      missed.push(row.track_id);
      continue;
    }
    failed.push({ error: outcome.error, trackId: row.track_id });
  }

  return { failed, missed, rateLimited, resolved };
}

async function refreshIsrcRows(
  rows: IsrcRefreshRow[],
  enabled: boolean,
  dryRun: boolean,
): Promise<{
  failed: Array<{ error: string; trackId: string }>;
  isrcRefreshMissed: string[];
  isrcRefreshed: string[];
  rateLimited: boolean;
}> {
  const failed: Array<{ error: string; trackId: string }> = [];
  const isrcRefreshMissed: string[] = [];
  const isrcRefreshed: string[] = [];
  let rateLimited = false;

  if (!enabled) {
    return { failed, isrcRefreshMissed, isrcRefreshed, rateLimited };
  }
  if (dryRun) {
    return {
      failed,
      isrcRefreshMissed,
      isrcRefreshed: rows.map((row) => row.track_id),
      rateLimited,
    };
  }

  for (const row of rows) {
    try {
      const { isrc, rateLimited: throttled } = await refreshIsrcByRecordingMbid(
        row.mb_recording_id,
      );
      if (throttled) {
        rateLimited = true;
        break;
      }

      await markIsrcRefreshed(row.track_id, isrc);
      if (isrc) {
        logEvent("info", "recording-mbids.isrc-refreshed", { isrc, trackId: row.track_id });
        isrcRefreshed.push(row.track_id);
      } else {
        isrcRefreshMissed.push(row.track_id);
      }
    } catch (error) {
      failed.push({
        error: error instanceof Error ? error.message : String(error),
        trackId: row.track_id,
      });
    }
  }

  return { failed, isrcRefreshMissed, isrcRefreshed, rateLimited };
}

export async function resolveRecordingMbids(
  limit: number,
  dryRun: boolean,
  cursor?: string,
  isrcRefreshLimit: number = MAX_ISRC_REFRESH_BATCH,
): Promise<RecordingMbidsResolveResult> {
  const batchLimit = Math.max(1, Math.min(limit, MAX_API_BATCH));
  const refreshLimit = Math.max(0, Math.min(isrcRefreshLimit, MAX_ISRC_REFRESH_BATCH));
  const dueWorkCutoverEnabled = await isDueWorkCutoverEnabled();
  const db = await getDb();

  let prefixStripped = 0;
  if (!cursor && dueWorkCutoverEnabled) {
    const prefixPage = await readPromotedDueWorkPage(db, "mbid-prefix-strip", {
      limit: PREFIX_STRIP_BATCH,
    });
    const eligiblePrefixIds = await projectedStrippableCrawlerIds(db, prefixPage.subjectIds);
    prefixStripped = dryRun
      ? eligiblePrefixIds.length
      : await stripProjectedCrawlerPrefixes(db, eligiblePrefixIds);
  } else if (!cursor) {
    prefixStripped = dryRun ? await countStrippableCrawlerRows() : await stripCrawlerPrefixes();
  }

  let rows: IsrcWorkRow[];
  let lookupProjectionEmpty = false;
  if (dueWorkCutoverEnabled) {
    const lookupPage = await readPromotedDueWorkPage(db, "mbid-isrc-lookup", {
      continuation: cursor
        ? {
            sortKey: encodeDueWorkOrder([{ direction: "asc", kind: "text", value: cursor }]),
            subjectId: cursor,
          }
        : undefined,
      limit: batchLimit,
    });
    lookupProjectionEmpty = lookupPage.subjectIds.length === 0;
    rows = await hydrateIsrcWork(lookupPage.subjectIds);
  } else {
    rows = await listIsrcWork(batchLimit, cursor);
  }

  const resolvedRows = await resolveIsrcRows(rows, dryRun);
  const { missed, resolved } = resolvedRows;
  const failed = [...resolvedRows.failed];
  let { rateLimited } = resolvedRows;

  const refreshIdle =
    !cursor &&
    !rateLimited &&
    (dueWorkCutoverEnabled ? lookupProjectionEmpty : rows.length === 0) &&
    refreshLimit > 0;
  let refreshRows: IsrcRefreshRow[] = [];

  if (refreshIdle && dueWorkCutoverEnabled) {
    const refreshPage = await readPromotedDueWorkPage(db, "mbid-isrc-refresh", {
      limit: refreshLimit,
    });
    refreshRows = await hydrateIsrcRefreshWork(refreshPage.subjectIds);
  } else if (refreshIdle) {
    const refreshCutoff = new Date(
      Date.now() - ISRC_REFRESH_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    refreshRows = await listIsrcRefreshWork(refreshLimit, refreshCutoff);
  }

  const refreshedRows = await refreshIsrcRows(refreshRows, refreshIdle, dryRun);
  const { isrcRefreshMissed, isrcRefreshed } = refreshedRows;
  failed.push(...refreshedRows.failed);
  rateLimited ||= refreshedRows.rateLimited;

  const lastTrackId = rows.at(-1)?.track_id ?? null;
  const nextCursor = rateLimited || rows.length < batchLimit ? null : lastTrackId;

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    isrcRefreshMissed,
    isrcRefreshMissedCount: isrcRefreshMissed.length,
    isrcRefreshed,
    isrcRefreshedCount: isrcRefreshed.length,
    missed,
    missedCount: missed.length,
    nextCursor,
    prefixStripped,
    rateLimited,
    resolved,
    resolvedCount: resolved.length,
  };
}
