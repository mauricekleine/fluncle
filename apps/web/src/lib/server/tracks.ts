import { logPageUrl } from "../fluncle-links";
import { type Galaxy, GALAXIES, galaxyForVibe } from "../galaxies";
import { type FeedItem, type MixtapeMember, rowToMixtape } from "../mixtapes";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";

export type TrackCursor = {
  addedAt: string;
  trackId: string;
};

/**
 * Enrichment's track-level spectral summary (from `features_json`), surfaced as
 * creative fuel for the video agent — it steers concept choices (vehicle,
 * texture, which band drives what), never per-frame reactivity (that is the
 * Remotion pipeline's own analysis). Absent until a track is enriched.
 */
export type TrackFeatures = {
  /** Spectral centroid in Hz — overall brightness. */
  centroidHz?: number;
  /** Fraction of energy >5kHz — treble/air. 0..1. */
  highRatio?: number;
  /** Spectral flatness of the mids — tonal (low) vs noisy (high). 0..1. */
  midFlatness?: number;
  /** Onsets per second — rhythmic busyness. */
  onsetRate?: number;
  /** Fraction of energy <120Hz — sub-bass weight. 0..1. */
  subBassRatio?: number;
};

export type TrackListItem = {
  addedAt: string;
  addedToSpotify: boolean;
  album?: string;
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  durationMs: number;
  enrichmentStatus: string;
  /** Track-level spectral descriptors (creative fuel); absent until enriched. */
  features?: TrackFeatures;
  /** Derived vibe galaxy (the four quadrants); absent until placed. See lib/galaxies. */
  galaxy?: { key: Galaxy; name: string };
  isrc?: string;
  key?: string;
  label?: string;
  logId?: string;
  /** The finding's permanent log page on fluncle.com; absent until a Log ID exists. */
  logPageUrl?: string;
  note?: string;
  popularity?: number;
  postedToTelegram: boolean;
  previewUrl?: string;
  releaseDate?: string;
  spotifyUrl: string;
  /** The live TikTok post URL, if a published post exists (from social_posts). */
  tiktokUrl?: string;
  /** The live YouTube post URL, if a published post exists (from social_posts). */
  youtubeUrl?: string;
  title: string;
  trackId: string;
  /** Last content change to the record; absent for rows predating the column. */
  updatedAt?: string;
  /** The AI model that authored the video, in <provider>/<model> notation. */
  videoModel?: string;
  /** The reasoning/thinking effort the authoring model ran at (e.g. "high"). */
  videoModelReasoning?: string;
  videoUrl?: string;
  /** The video's travelling vehicle — the diversity ledger for the video agent. */
  videoVehicle?: string;
  /** Vibe-map placement (admin tagging). Light(-1)↔Dark(+1); absent = unplaced. */
  vibeX?: number;
  /** Vibe-map placement. Floaty(-1)↔Driving(+1); absent = unplaced. */
  vibeY?: number;
  type?: "finding";
};

export type TrackListPage = {
  nextCursor?: string;
  totalCount: number;
  tracks: TrackListItem[];
};

export type FeedListPage = Omit<TrackListPage, "tracks"> & {
  tracks: FeedItem[];
};

type TrackRow = {
  added_at: string;
  album: string | null;
  album_image_url: string | null;
  artists_json: string;
  bpm: number | null;
  duration_ms: number;
  enrichment_status: string;
  features_json: string | null;
  isrc: string | null;
  key: string | null;
  label: string | null;
  log_id: string | null;
  note: string | null;
  popularity: number | null;
  preview_url: string | null;
  release_date: string | null;
  spotify_url: string;
  tiktok_url: string | null;
  youtube_url: string | null;
  title: string;
  track_id: string;
  updated_at: string | null;
  video_model: string | null;
  video_model_reasoning: string | null;
  video_url: string | null;
  video_vehicle: string | null;
  vibe_x: number | null;
  vibe_y: number | null;
  added_to_spotify: number;
  posted_to_telegram: number;
};

type MixtapeFeedRow = {
  added_at: string;
  cover_image_url: string | null;
  duration_ms: number | null;
  id: string;
  log_id: string;
  member_count: number;
  mixcloud_url: string | null;
  note: string | null;
  sequence_number: number | null;
  soundcloud_url: string | null;
  title: string;
  updated_at: string | null;
  youtube_url: string | null;
};

// Columns exposed to clients. `features_json` is the enrichment spectral summary,
// surfaced (parsed) as creative fuel for the video agent.
const TRACK_SELECT = `tracks.track_id, tracks.spotify_url, tracks.title, tracks.album, tracks.album_image_url, tracks.artists_json,
  tracks.bpm, tracks.duration_ms, tracks.enrichment_status, tracks.features_json, tracks.isrc, tracks.key, tracks.label, tracks.log_id, tracks.popularity,
  tracks.preview_url, tracks.release_date, tracks.video_url, tracks.video_vehicle, tracks.video_model, tracks.video_model_reasoning, tracks.note, tracks.added_at,
  tracks.updated_at, tracks.vibe_x, tracks.vibe_y, tracks.added_to_spotify, tracks.posted_to_telegram,
  (select url from social_posts
     where track_id = tracks.track_id and platform = 'tiktok' and status = 'published'
       and url is not null
     order by published_at desc limit 1) as tiktok_url,
  (select url from social_posts
     where track_id = tracks.track_id and platform = 'youtube' and status = 'published'
       and url is not null
     order by published_at desc limit 1) as youtube_url`;

/** A finite number, or undefined — for tolerant parsing of stored feature JSON. */
function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse the enrichment `features_json` into a typed spectral summary, or undefined. */
function parseFeatures(json: string | null): TrackFeatures | undefined {
  if (!json) {
    return undefined;
  }
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const features: TrackFeatures = {
      centroidHz: finiteOrUndefined(raw.centroidHz),
      highRatio: finiteOrUndefined(raw.highRatio),
      midFlatness: finiteOrUndefined(raw.midFlatness),
      onsetRate: finiteOrUndefined(raw.onsetRate),
      subBassRatio: finiteOrUndefined(raw.subBassRatio),
    };
    return Object.values(features).some((v) => v !== undefined) ? features : undefined;
  } catch {
    return undefined;
  }
}

function galaxyOf(x: number | null, y: number | null): { key: Galaxy; name: string } | undefined {
  if (x == null || y == null) {
    return undefined;
  }

  const key = galaxyForVibe(x, y);
  return { key, name: GALAXIES[key].name };
}

function toTrackListItem(row: TrackRow): TrackListItem {
  return {
    addedAt: row.added_at,
    addedToSpotify: Boolean(row.added_to_spotify),
    album: row.album ?? undefined,
    albumImageUrl: row.album_image_url ?? undefined,
    artists: parseArtistsJson(row.artists_json),
    bpm: row.bpm ?? undefined,
    durationMs: row.duration_ms,
    enrichmentStatus: row.enrichment_status,
    features: parseFeatures(row.features_json),
    galaxy: galaxyOf(row.vibe_x, row.vibe_y),
    isrc: row.isrc ?? undefined,
    key: row.key ?? undefined,
    label: row.label ?? undefined,
    logId: row.log_id ?? undefined,
    logPageUrl: row.log_id ? logPageUrl(row.log_id) : undefined,
    note: row.note?.trim() ? row.note : undefined,
    popularity: row.popularity ?? undefined,
    postedToTelegram: Boolean(row.posted_to_telegram),
    previewUrl: row.preview_url ?? undefined,
    releaseDate: row.release_date ?? undefined,
    spotifyUrl: row.spotify_url,
    tiktokUrl: row.tiktok_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
    type: "finding",
    updatedAt: row.updated_at ?? undefined,
    vibeX: row.vibe_x ?? undefined,
    vibeY: row.vibe_y ?? undefined,
    videoModel: row.video_model ?? undefined,
    videoModelReasoning: row.video_model_reasoning ?? undefined,
    videoUrl: row.video_url ?? undefined,
    videoVehicle: row.video_vehicle ?? undefined,
    youtubeUrl: row.youtube_url ?? undefined,
  };
}

/** Fetch a single track by its Spotify trackId or its Log ID. */
export async function getTrackByIdOrLogId(idOrLogId: string): Promise<TrackListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId],
    sql: `select ${TRACK_SELECT} from tracks where track_id = ? or log_id = ? limit 1`,
  });
  const row = typedRow<TrackRow>(result.rows);

  return row ? toTrackListItem(row) : undefined;
}

export async function getTracksForMixtape(mixtapeId: string): Promise<MixtapeMember[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [mixtapeId],
    sql: `select ${TRACK_SELECT}, mt.start_ms as start_ms
          from tracks
          join mixtape_tracks mt on mt.track_id = tracks.track_id and mt.mixtape_id = ?
          order by mt.position asc`,
  });

  return typedRows<TrackRow & { start_ms: number | null }>(result.rows).map((row) => ({
    ...toTrackListItem(row),
    startMs: row.start_ms ?? undefined,
  }));
}

/** One random certified track, mapped like every other list item. */
export async function getRandomTrack(): Promise<TrackListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select ${TRACK_SELECT} from tracks order by random() limit 1`,
  });
  const row = typedRow<TrackRow>(result.rows);

  return row ? toTrackListItem(row) : undefined;
}

export type TrackNeighbor = {
  artists: string[];
  logId: string;
  title: string;
};

type NeighborRow = {
  artists_json: string;
  log_id: string;
  title: string;
};

/**
 * The adjacent coordinate-bearing findings in found order — the log page's
 * newer/older links (crawlable adjacency through the whole archive).
 */
export async function getTrackNeighbors(track: {
  addedAt: string;
  trackId: string;
}): Promise<{ newer?: TrackNeighbor; older?: TrackNeighbor }> {
  const db = await getDb();
  const select = `select log_id, title, artists_json from tracks where log_id is not null`;
  const [newerResult, olderResult] = await Promise.all([
    db.execute({
      args: [track.addedAt, track.addedAt, track.trackId],
      sql: `${select} and (added_at > ? or (added_at = ? and track_id > ?))
            order by added_at asc, track_id asc limit 1`,
    }),
    db.execute({
      args: [track.addedAt, track.addedAt, track.trackId],
      sql: `${select} and (added_at < ? or (added_at = ? and track_id < ?))
            order by added_at desc, track_id desc limit 1`,
    }),
  ]);
  const toNeighbor = (row: NeighborRow | undefined): TrackNeighbor | undefined =>
    row
      ? { artists: parseArtistsJson(row.artists_json), logId: row.log_id, title: row.title }
      : undefined;

  return {
    newer: toNeighbor(typedRow<NeighborRow>(newerResult.rows)),
    older: toNeighbor(typedRow<NeighborRow>(olderResult.rows)),
  };
}

/**
 * Other coordinate-bearing findings in the SAME vibe-map galaxy — the quadrant is
 * the sign of each vibe axis (galaxyForVibe is inclusive toward dark/driving:
 * x>=0, y>=0). Powers the log page's "more in this galaxy" cluster: crawlable
 * TOPICAL adjacency, not just the linear newer/older chain. Empty for a finding
 * that isn't placed on the map yet.
 */
export async function getRelatedTracks(
  track: { trackId: string; vibeX?: number; vibeY?: number },
  limit = 6,
): Promise<TrackNeighbor[]> {
  if (track.vibeX === undefined || track.vibeY === undefined) {
    return [];
  }

  const db = await getDb();
  const xCond = track.vibeX < 0 ? "vibe_x < 0" : "vibe_x >= 0";
  const yCond = track.vibeY < 0 ? "vibe_y < 0" : "vibe_y >= 0";
  const result = await db.execute({
    args: [track.trackId, limit],
    sql: `select log_id, title, artists_json from tracks
          where log_id is not null and vibe_x is not null and vibe_y is not null
            and ${xCond} and ${yCond} and track_id != ?
          order by added_at desc, track_id desc limit ?`,
  });

  return typedRows<NeighborRow>(result.rows).map((row) => ({
    artists: parseArtistsJson(row.artists_json),
    logId: row.log_id,
    title: row.title,
  }));
}

type TrackCountRow = {
  total_count: number;
};

type ListTracksOptions = {
  cursor?: TrackCursor;
  /** Only findings with a rendered video — the Stories feed's filter. */
  hasVideo?: boolean;
  includeMixtapes?: boolean;
  limit: number;
  /**
   * Found-order direction. "desc" (newest-first) is the public default; the
   * admin tagging queue passes "asc" to work the oldest unlabelled finds first.
   */
  order?: "asc" | "desc";
  /**
   * Admin tagging cursor: "unplaced" = not yet dropped on the vibe map (needs
   * review); "placed" = the operator has assigned a vibe coordinate. Drives the
   * tagging queue and its toggle. Omitted for public reads.
   */
  placement?: "placed" | "unplaced";
  since?: string;
  until?: string;
};

export function listTracks(
  options: ListTracksOptions & { includeMixtapes: true },
): Promise<FeedListPage>;
export function listTracks(options: ListTracksOptions): Promise<TrackListPage>;
export async function listTracks({
  cursor,
  hasVideo,
  includeMixtapes = false,
  limit,
  order = "desc",
  placement,
  since,
  until,
}: ListTracksOptions): Promise<FeedListPage | TrackListPage> {
  const db = await getDb();

  // Discovery-window and video filters; totalCount is scoped to the same
  // filters so a windowed caller (the newsletter agent) or the Stories feed
  // gets the matching count, while the homepage's unfiltered calls keep the
  // global archive count for numbering.
  const filterClauses: string[] = [];
  const filterArgs: string[] = [];

  if (since) {
    filterClauses.push("added_at >= ?");
    filterArgs.push(since);
  }

  if (until) {
    filterClauses.push("added_at < ?");
    filterArgs.push(until);
  }

  if (hasVideo === true) {
    filterClauses.push("video_url is not null");
  } else if (hasVideo === false) {
    filterClauses.push("video_url is null");
  }

  if (placement === "unplaced") {
    filterClauses.push("vibe_x is null");
  } else if (placement === "placed") {
    filterClauses.push("vibe_x is not null");
  }

  // asc/desc are internal literals (never user strings), so they interpolate
  // safely; the cursor comparison flips with the direction.
  const dir = order === "asc" ? "asc" : "desc";
  const cursorComparator =
    dir === "asc"
      ? "(added_at > ? or (added_at = ? and track_id > ?))"
      : "(added_at < ? or (added_at = ? and track_id < ?))";

  const countWhere = filterClauses.length > 0 ? `where ${filterClauses.join(" and ")}` : "";
  const listClauses = cursor ? [...filterClauses, cursorComparator] : filterClauses;
  const where = listClauses.length > 0 ? `where ${listClauses.join(" and ")}` : "";
  const cursorArgs = cursor ? [cursor.addedAt, cursor.addedAt, cursor.trackId] : [];
  const args: Array<string | number> = [...filterArgs, ...cursorArgs, limit + 1];

  const [result, countResult] = await Promise.all([
    db.execute({
      args,
      sql: `select ${TRACK_SELECT}
            from tracks
            ${where}
            order by added_at ${dir}, track_id ${dir}
            limit ?`,
    }),
    db.execute({
      args: filterArgs,
      sql: `select count(*) as total_count from tracks ${countWhere}`,
    }),
  ]);
  const rows = typedRows<TrackRow>(result.rows);
  const feedRows =
    includeMixtapes && !since && !until && hasVideo === undefined && placement === undefined
      ? await listPublishedMixtapeFeedRows(db, cursor, cursorComparator, cursorArgs, dir, limit)
      : undefined;
  const countRows = typedRows<TrackCountRow>(countResult.rows);
  const totalCount = feedFindingsCount(countRows[0]?.total_count, rows.length);

  if (feedRows) {
    const {
      items,
      hasMore,
      nextCursor: nextRawCursor,
    } = mergeFeedPage(
      rows.map(toTrackListItem),
      feedRows.map((row) => rowToMixtape(row)),
      dir,
      limit,
    );
    return {
      nextCursor: hasMore && nextRawCursor ? encodeTrackCursor(nextRawCursor) : undefined,
      totalCount,
      tracks: items,
    };
  }

  const visibleRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastVisibleRow = visibleRows.at(-1);

  return {
    nextCursor:
      hasMore && lastVisibleRow
        ? encodeTrackCursor({
            addedAt: lastVisibleRow.added_at,
            trackId: lastVisibleRow.track_id,
          })
        : undefined,
    totalCount,
    tracks: visibleRows.map(toTrackListItem),
  };
}

async function listPublishedMixtapeFeedRows(
  db: Awaited<ReturnType<typeof getDb>>,
  cursor: TrackCursor | undefined,
  cursorComparator: string,
  cursorArgs: string[],
  dir: "asc" | "desc",
  limit: number,
): Promise<MixtapeFeedRow[]> {
  const result = await db.execute({
    args: [...cursorArgs, limit + 1],
    sql: `select
            m.id,
            m.log_id,
            m.sequence_number,
            m.title,
            m.cover_image_url,
            m.duration_ms,
            m.note,
            m.mixcloud_url,
            m.youtube_url,
            m.soundcloud_url,
            m.added_at,
            m.updated_at,
            (select count(*) from mixtape_tracks mt where mt.mixtape_id = m.id) as member_count
          from mixtapes m
          where m.status = 'published'
            and m.log_id is not null
            and m.added_at is not null
            ${cursor ? `and ${cursorComparator.replaceAll("track_id", "log_id")}` : ""}
          order by m.added_at ${dir}, m.log_id ${dir}
          limit ?`,
  });

  return typedRows<MixtapeFeedRow>(result.rows);
}

function itemCursorId(item: FeedItem): string {
  return item.type === "mixtape" ? (item.logId as string) : item.trackId;
}

function compareFeedItems(left: FeedItem, right: FeedItem, dir: "asc" | "desc"): number {
  const direction = dir === "asc" ? 1 : -1;
  const byDate = binaryCompare(left.addedAt ?? "", right.addedAt ?? "");

  if (byDate !== 0) {
    return byDate * direction;
  }

  return binaryCompare(itemCursorId(left), itemCursorId(right)) * direction;
}

function binaryCompare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

// The JS mirror of the SQL cursor comparator. The feed fetches findings and
// mixtapes in two separate queries (each filtered by the same cursor and
// limited to limit+1), then merges in JS. This helper reproduces the cursor
// filter so mergeFeedPage can be tested end-to-end without a database.
function isAfterCursor(item: FeedItem, cursor: TrackCursor, dir: "asc" | "desc"): boolean {
  const itemAddedAt = item.addedAt ?? "";
  const itemId = itemCursorId(item);
  const byDate = binaryCompare(itemAddedAt, cursor.addedAt);

  if (dir === "desc") {
    if (byDate < 0) {
      return true;
    }
    if (byDate === 0) {
      return binaryCompare(itemId, cursor.trackId) < 0;
    }
    return false;
  }

  if (byDate > 0) {
    return true;
  }
  if (byDate === 0) {
    return binaryCompare(itemId, cursor.trackId) > 0;
  }
  return false;
}

/**
 * Merge findings and mixtapes into a single feed page. Both tables are fetched
 * separately (each over-fetching by one), then concatenated, sorted by
 * `addedAt` (tiebreak: the cursor id — `trackId` for findings, `logId` for
 * mixtapes), and sliced to `limit+1`. The first `limit` items are the visible
 * page; the extra item signals `hasMore` and seeds the next cursor.
 *
 * When `cursor` is provided, each array is filtered by the same comparator the
 * SQL cursor uses (so the function can simulate full paging in tests without a
 * database). `listTracks` calls this WITHOUT a cursor — the SQL already
 * filtered — so the filter is a no-op in production and only exercised by tests.
 *
 * Each table is sorted before slicing to `limit+1` — the JS mirror of the SQL
 * `order by ... limit ?`. In production the SQL already sorted the rows, so the
 * sort is a cheap no-op; it makes the function self-contained for tests that
 * pass unsorted fixtures.
 */
export function mergeFeedPage(
  findings: FeedItem[],
  mixtapes: FeedItem[],
  dir: "asc" | "desc",
  limit: number,
  cursor?: TrackCursor,
): { items: FeedItem[]; hasMore: boolean; nextCursor?: TrackCursor } {
  const filteredFindings = cursor
    ? findings.filter((item) => isAfterCursor(item, cursor, dir))
    : findings.slice();
  const filteredMixtapes = cursor
    ? mixtapes.filter((item) => isAfterCursor(item, cursor, dir))
    : mixtapes.slice();

  // Over-fetch limit+1 from each table (matches the SQL `limit ?` with limit+1).
  const findingsPage = filteredFindings
    .sort((left, right) => compareFeedItems(left, right, dir))
    .slice(0, limit + 1);
  const mixtapesPage = filteredMixtapes
    .sort((left, right) => compareFeedItems(left, right, dir))
    .slice(0, limit + 1);

  const merged = [...findingsPage, ...mixtapesPage]
    .sort((left, right) => compareFeedItems(left, right, dir))
    .slice(0, limit + 1);

  const items = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  const lastVisible = items.at(-1);
  const nextCursor =
    hasMore && lastVisible
      ? { addedAt: lastVisible.addedAt ?? "", trackId: itemCursorId(lastVisible) }
      : undefined;

  return { hasMore, items, nextCursor };
}

/**
 * The feed's "Found · N" counter is findings-only by design: mixtapes join the
 * feed stream without inflating the finding count. `listTracks` passes the
 * dedicated `count(*) from tracks` result (and the findings row count as
 * fallback); mixtapes never enter the count. Extracting this as a named helper
 * makes the invariant explicit and testable — a future change that unions
 * mixtapes into the count would have to touch this function and its tests.
 */
export function feedFindingsCount(sqlCount: number | undefined, fallback: number): number {
  return Number(sqlCount ?? fallback);
}

export type VibePoint = {
  artists: string[];
  title: string;
  trackId: string;
  vibeX: number;
  vibeY: number;
};

type VibePointRow = {
  artists_json: string;
  title: string;
  track_id: string;
  vibe_x: number;
  vibe_y: number;
};

/**
 * Every placed finding as a lightweight vibe-map point — the backdrop the admin
 * tagging map draws so each new placement is judged RELATIVE to the ones before
 * it. Whole-set fetch is fine at this scale; cluster it when the map gets busy
 * (docs/admin-tagging.md).
 */
export async function listVibePoints(): Promise<VibePoint[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select track_id, title, artists_json, vibe_x, vibe_y
          from tracks
          where vibe_x is not null and vibe_y is not null
          order by added_at desc`,
  });

  return typedRows<VibePointRow>(result.rows).map((row) => ({
    artists: parseArtistsJson(row.artists_json),
    title: row.title,
    trackId: row.track_id,
    vibeX: row.vibe_x,
    vibeY: row.vibe_y,
  }));
}

export function decodeTrackCursor(value: string | null): TrackCursor | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TrackCursor;

    if (typeof parsed.addedAt === "string" && typeof parsed.trackId === "string") {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function encodeTrackCursor(cursor: TrackCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
