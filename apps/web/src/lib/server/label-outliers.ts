import { type InStatement, type InValue } from "@libsql/client";
import {
  type LabelOutlierInputAlbum,
  type LabelOutlierInputTrack,
  type LabelOutlierItem,
  type LabelOutlierRun,
  type RecordedLabelOutlier,
} from "@fluncle/contracts";
import { getDb, typedRows } from "./db";
import { getSetting } from "./settings";

export const LABEL_OUTLIERS_LAST_RUN_KEY = "label_outliers_last_run";

export const MIN_CORPUS_FRACTION_OF_LIVE = 0.8;

const PENDING_ALERT_NAME_LIMIT = 50;

const SCORE_EPSILON = 0.001;

const Z_EPSILON = 0.05;

export type RecordLabelOutliersInput = {
  labelsScored: number;
  outliers: RecordedLabelOutlier[];
  replicaSyncedAt: string | null;
  totalFlagged: number;
  tracksScored: number;
  unitsScored: number;
};

export type PendingLabelOutlierAlert = {
  albumName: string | null;
  labelName: string | null;
  title: string;
  unitId: string;
};

export type AlertedLabelOutlier = { fingerprint: string; unitId: string };

export type RecordLabelOutliersResult = {
  flagged: number;
  pendingAlertUnits: AlertedLabelOutlier[];
  pendingAlerts: PendingLabelOutlierAlert[];
  removed: number;
};

export class LabelOutlierRunRejected extends Error {}

export class InvalidLabelOutlierInputsCursor extends Error {}

export type LabelOutlierInputsPage = {
  albums: LabelOutlierInputAlbum[];
  nextCursor: string | null;
  tracks: LabelOutlierInputTrack[];
};

const EMBEDDED_CATALOGUE_RANGE = `from track_embeddings e
  cross join tracks t on t.track_id = e.track_id
  where t.is_catalogue = 1 and e.track_id > ?`;

export function encodeLabelOutlierInputsCursor(trackId: string): string {
  return Buffer.from(trackId, "utf8").toString("base64url");
}

export function decodeLabelOutlierInputsCursor(cursor: string | undefined): string {
  if (cursor === undefined || cursor === "") {
    return "";
  }

  const decoded = Buffer.from(cursor, "base64url").toString("utf8");

  if (decoded === "" || encodeLabelOutlierInputsCursor(decoded) !== cursor) {
    throw new InvalidLabelOutlierInputsCursor(
      "the label-outlier inputs cursor is not one this op issued",
    );
  }

  return decoded;
}

function blobBase64(cell: unknown): string {
  if (cell instanceof ArrayBuffer) {
    return Buffer.from(cell).toString("base64");
  }

  if (ArrayBuffer.isView(cell)) {
    return Buffer.from(cell.buffer, cell.byteOffset, cell.byteLength).toString("base64");
  }

  throw new Error("a stored embedding is not a blob");
}

export async function listLabelOutlierInputsPage(
  cursor: string | undefined,
  limit: number,
): Promise<LabelOutlierInputsPage> {
  const after = decodeLabelOutlierInputsCursor(cursor);
  const db = await getDb();
  const result = await db.execute({
    args: [after, limit + 1],
    sql: `select e.track_id, t.label_id, t.album_id, e.embedding_blob,
                 (select json_group_array(ta.artist_id)
                    from track_artists ta
                   where ta.track_id = e.track_id) as artist_ids,
                 (select a.discogs_styles
                    from albums a
                   where a.id = t.album_id) as album_styles
            ${EMBEDDED_CATALOGUE_RANGE}
           order by e.track_id
           limit ?`,
  });
  const rows = typedRows<{
    album_id: string | null;
    album_styles: string | null;
    artist_ids: string | null;
    embedding_blob: unknown;
    label_id: string | null;
    track_id: string;
  }>(result.rows);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1)?.track_id;
  const albums = new Map<string, string>();

  for (const row of page) {
    if (row.album_id !== null && row.album_styles !== null) {
      albums.set(row.album_id, row.album_styles);
    }
  }

  return {
    albums: [...albums].map(([id, discogsStyles]) => ({ discogsStyles, id })),
    nextCursor: hasMore && last !== undefined ? encodeLabelOutlierInputsCursor(last) : null,
    tracks: page.map((row) => ({
      albumId: row.album_id,
      artistIds: parseArtistIds(row.artist_ids),
      embeddingBase64: blobBase64(row.embedding_blob),
      labelId: row.label_id,
      trackId: row.track_id,
    })),
  };
}

function parseArtistIds(raw: string | null): string[] {
  const parsed: unknown = JSON.parse(raw ?? "[]");

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("a track's artist credits did not read back as a list of ids");
  }

  return parsed;
}

type StoredOutlierRow = {
  album_id: string | null;
  artist_support: number;
  fingerprint: string;
  label_id: string | null;
  reference: string;
  reference_median: number;
  score: number;
  single_track_id: string | null;
  track_count: number;
  unit_id: string;
  z: number;
};

type DismissalRow = { fingerprint: string; unit_id: string };

export function outlierChanged(stored: StoredOutlierRow, next: RecordedLabelOutlier): boolean {
  return (
    stored.fingerprint !== next.fingerprint ||
    stored.album_id !== next.albumId ||
    stored.label_id !== next.labelId ||
    stored.single_track_id !== next.singleTrackId ||
    stored.reference !== next.reference ||
    Number(stored.track_count) !== next.trackCount ||
    Number(stored.artist_support) !== next.artistSupport ||
    Math.abs(Number(stored.score) - next.score) > SCORE_EPSILON ||
    Math.abs(Number(stored.reference_median) - next.referenceMedian) > SCORE_EPSILON ||
    Math.abs(Number(stored.z) - next.z) > Z_EPSILON
  );
}

export function runRejection(
  input: RecordLabelOutliersInput,
  liveEmbeddedTracks: number,
): string | null {
  const distinct = new Set(input.outliers.map((outlier) => outlier.unitId)).size;

  if (distinct !== input.outliers.length) {
    return `the run posted ${input.outliers.length} units but only ${distinct} distinct ids; a duplicated list never replaces the stored one`;
  }

  if (input.totalFlagged !== input.outliers.length) {
    return `the run flagged ${input.totalFlagged} units but posted ${input.outliers.length}; a partial list never replaces the stored one`;
  }

  if (input.tracksScored === 0 || input.unitsScored === 0) {
    return "the run scored no tracks; an empty corpus never replaces the stored list";
  }

  if (input.tracksScored < liveEmbeddedTracks * MIN_CORPUS_FRACTION_OF_LIVE) {
    return `the run scored ${input.tracksScored} tracks but the archive holds ${liveEmbeddedTracks} embedded catalogue tracks; a read that far behind is broken, not current`;
  }

  return null;
}

export function labelOutlierTracksStatement(
  albumIds: readonly string[],
  singleTrackIds: readonly string[],
): { args: InValue[]; sql: string } {
  return {
    args: [JSON.stringify(albumIds), JSON.stringify(singleTrackIds)],
    sql: `select t.track_id, t.title, t.album_id, t.label_id
            from tracks t
           where (t.album_id in (select value from json_each(?)) and +t.is_catalogue = 1)
              or t.track_id in (select value from json_each(?))
           order by t.title collate nocase asc, t.track_id asc`,
  };
}

export async function countLiveEmbeddedCatalogueTracks(): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `select count(*) as n from tracks where is_catalogue = 1 and has_embedding = 1`,
  );

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

function dedupeByUnit(outliers: readonly RecordedLabelOutlier[]): RecordedLabelOutlier[] {
  const byUnit = new Map<string, RecordedLabelOutlier>();

  for (const outlier of outliers) {
    byUnit.set(outlier.unitId, outlier);
  }

  return [...byUnit.values()];
}

function outlierArgs(outlier: RecordedLabelOutlier) {
  return [
    outlier.albumId,
    outlier.artistSupport,
    outlier.fingerprint,
    outlier.labelId,
    outlier.reference,
    outlier.referenceMedian,
    outlier.score,
    outlier.singleTrackId,
    outlier.trackCount,
  ];
}

export async function listPendingAlerts(): Promise<{
  units: AlertedLabelOutlier[];
  named: PendingLabelOutlierAlert[];
}> {
  const db = await getDb();
  const result = await db.execute(
    `select o.unit_id, o.fingerprint, a.name as album_name, l.name as label_name,
            coalesce(st.title, a.name, o.unit_id) as title
       from label_outliers o
       left join label_outlier_dismissals d
         on d.unit_id = o.unit_id and d.fingerprint = o.fingerprint
       left join albums a on a.id = o.album_id
       left join labels l on l.id = o.label_id
       left join tracks st on st.track_id = o.single_track_id
      where o.alerted_at is null and d.unit_id is null
      order by o.z asc, o.unit_id asc`,
  );
  const rows = typedRows<{
    album_name: string | null;
    fingerprint: string;
    label_name: string | null;
    title: string;
    unit_id: string;
  }>(result.rows);

  return {
    named: rows.slice(0, PENDING_ALERT_NAME_LIMIT).map((row) => ({
      albumName: row.album_name,
      labelName: row.label_name,
      title: row.title,
      unitId: row.unit_id,
    })),
    units: rows.map((row) => ({ fingerprint: row.fingerprint, unitId: row.unit_id })),
  };
}

export async function acknowledgeLabelOutlierAlerts(
  units: readonly AlertedLabelOutlier[],
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [now(), JSON.stringify(units.map((unit) => [unit.unitId, unit.fingerprint]))],
    sql: `update label_outliers set alerted_at = ?
           where alerted_at is null
             and exists (
               select 1 from json_each(?) acked
                where acked.value ->> 0 = label_outliers.unit_id
                  and acked.value ->> 1 = label_outliers.fingerprint
             )`,
  });

  return result.rowsAffected;
}

export async function recordLabelOutliers(
  input: RecordLabelOutliersInput,
  now: () => string = () => new Date().toISOString(),
): Promise<RecordLabelOutliersResult> {
  const rejection = runRejection(input, await countLiveEmbeddedCatalogueTracks());

  if (rejection) {
    throw new LabelOutlierRunRejected(rejection);
  }

  const db = await getDb();
  const stamp = now();
  const incoming = dedupeByUnit(input.outliers);
  const [storedResult, dismissalResult] = await db.batch(
    [
      `select unit_id, album_id, artist_support, fingerprint, label_id, reference,
              reference_median, score, single_track_id, track_count, z
         from label_outliers`,
      "select unit_id, fingerprint from label_outlier_dismissals",
    ],
    "read",
  );
  const stored = new Map(
    typedRows<StoredOutlierRow>(storedResult?.rows ?? []).map((row) => [row.unit_id, row]),
  );
  const dismissals = new Map(
    typedRows<DismissalRow>(dismissalResult?.rows ?? []).map((row) => [
      row.unit_id,
      row.fingerprint,
    ]),
  );
  const incomingIds = new Set(incoming.map((outlier) => outlier.unitId));
  const statements: InStatement[] = [];

  for (const outlier of incoming) {
    const previous = stored.get(outlier.unitId);

    if (!previous) {
      statements.push({
        args: [...outlierArgs(outlier), outlier.unitId, outlier.z, stamp, stamp],
        sql: `insert into label_outliers
                (album_id, artist_support, fingerprint, label_id, reference, reference_median,
                 score, single_track_id, track_count, unit_id, z, first_flagged_at, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      });
      continue;
    }

    if (outlierChanged(previous, outlier)) {
      statements.push({
        args: [...outlierArgs(outlier), outlier.z, stamp, outlier.unitId],
        sql: `update label_outliers
                 set alerted_at = case when fingerprint = ?3 then alerted_at end,
                     album_id = ?1, artist_support = ?2, fingerprint = ?3, label_id = ?4,
                     reference = ?5, reference_median = ?6, score = ?7, single_track_id = ?8,
                     track_count = ?9, z = ?10, updated_at = ?11
               where unit_id = ?12`,
      });
    }
  }

  const removed = [...stored.keys()].filter((unitId) => !incomingIds.has(unitId));

  if (removed.length > 0) {
    statements.push({
      args: [JSON.stringify(removed)],
      sql: "delete from label_outliers where unit_id in (select value from json_each(?))",
    });
  }

  const flagged = incoming.filter(
    (outlier) => dismissals.get(outlier.unitId) !== outlier.fingerprint,
  ).length;
  const run: LabelOutlierRun = {
    flagged,
    labelsScored: input.labelsScored,
    ranAt: stamp,
    replicaSyncedAt: input.replicaSyncedAt,
    tracksScored: input.tracksScored,
    unitsScored: input.unitsScored,
  };

  statements.push({
    args: [LABEL_OUTLIERS_LAST_RUN_KEY, JSON.stringify(run)],
    sql: `insert into settings (key, value) values (?, ?)
          on conflict(key) do update set value = excluded.value`,
  });

  await db.batch(statements, "write");

  const pending = await listPendingAlerts();

  return {
    flagged,
    pendingAlertUnits: pending.units,
    pendingAlerts: pending.named,
    removed: removed.length,
  };
}

type OutlierListRow = {
  album_id: string | null;
  album_name: string | null;
  album_slug: string | null;
  artist_support: number;
  discogs_styles: string | null;
  dismissed_at: string | null;
  dismissed_fingerprint: string | null;
  fingerprint: string;
  first_flagged_at: string;
  label_id: string | null;
  label_name: string | null;
  label_slug: string | null;
  reference: "catalogue" | "label";
  reference_median: number;
  score: number;
  single_track_id: string | null;
  track_count: number;
  unit_id: string;
  z: number;
};

type OutlierTrackRow = {
  album_id: string | null;
  label_id: string | null;
  title: string;
  track_id: string;
};

type OutlierArtistRow = { name: string; slug: string; track_id: string };

function parseStyles(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed.filter((style): style is string => typeof style === "string")
      : [];
  } catch {
    return [];
  }
}

export function parseLastRun(raw: string | undefined): LabelOutlierRun | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LabelOutlierRun>;

    return typeof parsed.ranAt === "string" && typeof parsed.flagged === "number"
      ? {
          flagged: parsed.flagged,
          labelsScored: Number(parsed.labelsScored ?? 0),
          ranAt: parsed.ranAt,
          replicaSyncedAt:
            typeof parsed.replicaSyncedAt === "string" ? parsed.replicaSyncedAt : null,
          tracksScored: Number(parsed.tracksScored ?? 0),
          unitsScored: Number(parsed.unitsScored ?? 0),
        }
      : null;
  } catch {
    return null;
  }
}

export async function listLabelOutliers(): Promise<{
  items: LabelOutlierItem[];
  lastRun: LabelOutlierRun | null;
}> {
  const db = await getDb();
  const [rowsResult] = await db.batch(
    [
      `select o.unit_id, o.album_id, o.artist_support, o.fingerprint, o.first_flagged_at,
              o.label_id, o.reference, o.reference_median, o.score, o.single_track_id,
              o.track_count, o.z,
              a.name as album_name, a.slug as album_slug, a.discogs_styles,
              l.name as label_name, l.slug as label_slug,
              d.fingerprint as dismissed_fingerprint, d.dismissed_at
         from label_outliers o
         left join albums a on a.id = o.album_id
         left join labels l on l.id = o.label_id
         left join tracks st on st.track_id = o.single_track_id
         left join label_outlier_dismissals d on d.unit_id = o.unit_id
        where (o.album_id is null or a.id is not null)
          and (o.single_track_id is null or st.track_id is not null)
        order by o.z asc, o.unit_id asc`,
    ],
    "read",
  );
  const rows = typedRows<OutlierListRow>(rowsResult?.rows ?? []);
  const albumIds = [...new Set(rows.flatMap((row) => (row.album_id ? [row.album_id] : [])))];
  const singleIds = rows.flatMap((row) => (row.single_track_id ? [row.single_track_id] : []));
  const [trackResult, lastRunRaw] = await Promise.all([
    db.execute(labelOutlierTracksStatement(albumIds, singleIds)),
    getSetting(LABEL_OUTLIERS_LAST_RUN_KEY),
  ]);
  const trackRows = typedRows<OutlierTrackRow>(trackResult.rows);
  const artistResult = await db.execute({
    args: [JSON.stringify(trackRows.map((row) => row.track_id))],
    sql: `select ta.track_id, ar.name, ar.slug
            from track_artists ta
            join artists ar on ar.id = ta.artist_id
           where ta.track_id in (select value from json_each(?))
           order by ta.track_id asc, ta.position asc`,
  });
  const artistsByTrack = new Map<string, { name: string; slug: string }[]>();

  for (const row of typedRows<OutlierArtistRow>(artistResult.rows)) {
    const list = artistsByTrack.get(row.track_id) ?? [];
    list.push({ name: row.name, slug: row.slug });
    artistsByTrack.set(row.track_id, list);
  }

  const tracksByAlbumLabel = new Map<string, OutlierTrackRow[]>();
  const tracksById = new Map<string, OutlierTrackRow>();

  for (const row of trackRows) {
    tracksById.set(row.track_id, row);

    if (row.album_id) {
      const key = `${row.album_id}|${row.label_id ?? ""}`;
      const list = tracksByAlbumLabel.get(key) ?? [];
      list.push(row);
      tracksByAlbumLabel.set(key, list);
    }
  }

  const items = rows.map((row): LabelOutlierItem => {
    const unitTracks = row.album_id
      ? (tracksByAlbumLabel.get(`${row.album_id}|${row.label_id ?? ""}`) ?? [])
      : [row.single_track_id ? tracksById.get(row.single_track_id) : undefined].filter(
          (track): track is OutlierTrackRow => track !== undefined,
        );

    return {
      album:
        row.album_id && row.album_name && row.album_slug
          ? { id: row.album_id, name: row.album_name, slug: row.album_slug }
          : null,
      artistSupport: Number(row.artist_support),
      discogsStyles: parseStyles(row.discogs_styles),
      dismissedAt:
        row.dismissed_fingerprint !== null && row.dismissed_fingerprint === row.fingerprint
          ? row.dismissed_at
          : null,
      firstFlaggedAt: row.first_flagged_at,
      label:
        row.label_id && row.label_name && row.label_slug
          ? { id: row.label_id, name: row.label_name, slug: row.label_slug }
          : null,
      reference: row.reference,
      referenceMedian: Number(row.reference_median),
      score: Number(row.score),
      trackCount: Number(row.track_count),
      tracks: unitTracks.map((track) => ({
        artists: artistsByTrack.get(track.track_id) ?? [],
        title: track.title,
        trackId: track.track_id,
      })),
      unitId: row.unit_id,
      z: Number(row.z),
    };
  });

  return { items, lastRun: parseLastRun(lastRunRaw) };
}

export async function setLabelOutliersDismissed(
  unitIds: readonly string[],
  dismissed: boolean,
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  const db = await getDb();
  const ids = JSON.stringify([...new Set(unitIds)]);

  if (!dismissed) {
    const result = await db.execute({
      args: [ids],
      sql: "delete from label_outlier_dismissals where unit_id in (select value from json_each(?))",
    });

    return result.rowsAffected;
  }

  const result = await db.execute({
    args: [now(), ids],
    sql: `insert into label_outlier_dismissals (unit_id, fingerprint, dismissed_at)
          select o.unit_id, o.fingerprint, ?
            from label_outliers o
           where o.unit_id in (select value from json_each(?))
          on conflict(unit_id) do update set
            fingerprint = excluded.fingerprint,
            dismissed_at = excluded.dismissed_at`,
  });

  return result.rowsAffected;
}
