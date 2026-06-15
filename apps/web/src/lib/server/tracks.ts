import { type Galaxy, GALAXIES, galaxyForVibe } from "../galaxies";
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
  note?: string;
  popularity?: number;
  postedToTelegram: boolean;
  previewUrl?: string;
  releaseDate?: string;
  spotifyUrl: string;
  /** The live TikTok post URL, if a published post exists (from social_posts). */
  tiktokUrl?: string;
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
};

export type TrackListPage = {
  nextCursor?: string;
  totalCount: number;
  tracks: TrackListItem[];
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

// Columns exposed to clients. `features_json` is the enrichment spectral summary,
// surfaced (parsed) as creative fuel for the video agent.
const TRACK_SELECT = `track_id, spotify_url, title, album, album_image_url, artists_json,
  bpm, duration_ms, enrichment_status, features_json, isrc, key, label, log_id, popularity,
  preview_url, release_date, video_url, video_vehicle, video_model, video_model_reasoning, note, added_at,
  updated_at, vibe_x, vibe_y, added_to_spotify, posted_to_telegram,
  (select url from social_posts
     where track_id = tracks.track_id and platform = 'tiktok' and status = 'published'
       and url is not null
     order by published_at desc limit 1) as tiktok_url`;

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
    note: row.note?.trim() ? row.note : undefined,
    popularity: row.popularity ?? undefined,
    postedToTelegram: Boolean(row.posted_to_telegram),
    previewUrl: row.preview_url ?? undefined,
    releaseDate: row.release_date ?? undefined,
    spotifyUrl: row.spotify_url,
    tiktokUrl: row.tiktok_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
    updatedAt: row.updated_at ?? undefined,
    vibeX: row.vibe_x ?? undefined,
    vibeY: row.vibe_y ?? undefined,
    videoModel: row.video_model ?? undefined,
    videoModelReasoning: row.video_model_reasoning ?? undefined,
    videoUrl: row.video_url ?? undefined,
    videoVehicle: row.video_vehicle ?? undefined,
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

type TrackCountRow = {
  total_count: number;
};

export async function listTracks({
  cursor,
  hasVideo,
  limit,
  order = "desc",
  placement,
  since,
  until,
}: {
  cursor?: TrackCursor;
  /** Only findings with a rendered video — the Stories feed's filter. */
  hasVideo?: boolean;
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
}): Promise<TrackListPage> {
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

  if (hasVideo) {
    filterClauses.push("video_url is not null");
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
  const countRows = typedRows<TrackCountRow>(countResult.rows);
  const visibleRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastVisibleRow = visibleRows.at(-1);
  const totalCount = Number(countRows[0]?.total_count ?? visibleRows.length);

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
