import { getDb } from "./db";

export type TrackCursor = {
  addedAt: string;
  trackId: string;
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
  tags?: string[];
  tagsSource?: string;
  /** The live TikTok post URL, if a published post exists (from social_posts). */
  tiktokUrl?: string;
  title: string;
  trackId: string;
  /** Last content change to the record; absent for rows predating the column. */
  updatedAt?: string;
  videoUrl?: string;
  /** The video's travelling vehicle — the diversity ledger for the video agent. */
  videoVehicle?: string;
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
  isrc: string | null;
  key: string | null;
  label: string | null;
  log_id: string | null;
  note: string | null;
  popularity: number | null;
  preview_url: string | null;
  release_date: string | null;
  spotify_url: string;
  tags_json: string | null;
  tags_source: string | null;
  tiktok_url: string | null;
  title: string;
  track_id: string;
  updated_at: string | null;
  video_url: string | null;
  video_vehicle: string | null;
  added_to_spotify: number;
  posted_to_telegram: number;
};

// Columns exposed to clients (features_json is internal training data, omitted).
const TRACK_SELECT = `track_id, spotify_url, title, album, album_image_url, artists_json,
  bpm, duration_ms, enrichment_status, isrc, key, label, log_id, popularity,
  preview_url, release_date, tags_json, tags_source, video_url, video_vehicle, note, added_at,
  updated_at, added_to_spotify, posted_to_telegram,
  (select url from social_posts
     where track_id = tracks.track_id and platform = 'tiktok' and status = 'published'
       and url is not null
     order by published_at desc limit 1) as tiktok_url`;

function toTrackListItem(row: TrackRow): TrackListItem {
  return {
    addedAt: row.added_at,
    addedToSpotify: Boolean(row.added_to_spotify),
    album: row.album ?? undefined,
    albumImageUrl: row.album_image_url ?? undefined,
    artists: parseArtists(row.artists_json),
    bpm: row.bpm ?? undefined,
    durationMs: row.duration_ms,
    enrichmentStatus: row.enrichment_status,
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
    tags: parseTags(row.tags_json),
    tagsSource: row.tags_source ?? undefined,
    tiktokUrl: row.tiktok_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
    updatedAt: row.updated_at ?? undefined,
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
  const row = result.rows[0] as unknown as TrackRow | undefined;

  return row ? toTrackListItem(row) : undefined;
}

type TrackCountRow = {
  total_count: number;
};

export async function listTracks({
  cursor,
  hasVideo,
  limit,
  since,
  until,
}: {
  cursor?: TrackCursor;
  /** Only findings with a rendered video — the Stories feed's filter. */
  hasVideo?: boolean;
  limit: number;
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

  const countWhere = filterClauses.length > 0 ? `where ${filterClauses.join(" and ")}` : "";
  const listClauses = cursor
    ? [...filterClauses, "(added_at < ? or (added_at = ? and track_id < ?))"]
    : filterClauses;
  const where = listClauses.length > 0 ? `where ${listClauses.join(" and ")}` : "";
  const cursorArgs = cursor ? [cursor.addedAt, cursor.addedAt, cursor.trackId] : [];
  const args: Array<string | number> = [...filterArgs, ...cursorArgs, limit + 1];

  const [result, countResult] = await Promise.all([
    db.execute({
      args,
      sql: `select ${TRACK_SELECT}
            from tracks
            ${where}
            order by added_at desc, track_id desc
            limit ?`,
    }),
    db.execute({
      args: filterArgs,
      sql: `select count(*) as total_count from tracks ${countWhere}`,
    }),
  ]);
  const rows = result.rows as unknown as TrackRow[];
  const countRows = countResult.rows as unknown as TrackCountRow[];
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

function parseArtists(value: string): string[] {
  try {
    const artists = JSON.parse(value) as unknown;

    if (Array.isArray(artists)) {
      return artists.filter((artist): artist is string => typeof artist === "string");
    }
  } catch {
    return [];
  }

  return [];
}

function parseTags(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const tags = JSON.parse(value) as unknown;

    if (Array.isArray(tags)) {
      const strings = tags.filter((tag): tag is string => typeof tag === "string");

      return strings.length > 0 ? strings : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
