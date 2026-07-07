import {
  type FeedListPage,
  type Galaxy,
  type TrackCursor,
  type TrackFeatures,
  type TrackListPage,
  type TrackListItem,
} from "@fluncle/contracts";
import { logPageUrl } from "../fluncle-links";
import { GALAXIES, galaxyForVibe } from "../galaxies";
import { versionedObservationAudioUrl } from "../media";
import { nextBoundaryEpochMs, type RadioScheduleEntry } from "../radio-schedule";
import { type FeedItem, type MixtapeMember, rowToMixtape } from "../mixtapes";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import { discogsReleaseUrl } from "./discogs";
import { type EmbeddingCandidate, parseEmbedding, rankBySimilarity } from "./embedding";

export type { FeedListPage, TrackCursor, TrackFeatures, TrackListPage, TrackListItem };
export type { RadioScheduleEntry };

export type TrackRow = {
  added_at: string;
  album: string | null;
  album_image_url: string | null;
  artists_json: string;
  bpm: number | null;
  duration_ms: number;
  enrichment_status: string;
  features_json: string | null;
  in_release_id: number | null;
  isrc: string | null;
  key: string | null;
  label: string | null;
  log_id: string | null;
  note: string | null;
  observation_alignment_json: string | null;
  observation_audio_url: string | null;
  observation_duration_ms: number | null;
  observation_generated_at: string | null;
  popularity: number | null;
  preview_url: string | null;
  release_date: string | null;
  spotify_url: string;
  tiktok_url: string | null;
  youtube_url: string | null;
  title: string;
  track_id: string;
  updated_at: string | null;
  video_grain: string | null;
  video_model: string | null;
  video_model_reasoning: string | null;
  video_register: string | null;
  video_squared_at: string | null;
  video_url: string | null;
  video_vehicle: string | null;
  vibe_x: number | null;
  vibe_y: number | null;
  added_to_spotify: number;
  posted_to_telegram: number;
};

type MixtapeFeedRow = {
  added_at: string;
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
  tracks.bpm, tracks.duration_ms, tracks.enrichment_status, tracks.features_json, tracks.in_release_id, tracks.isrc, tracks.key, tracks.label, tracks.log_id, tracks.popularity,
  tracks.preview_url, tracks.release_date, tracks.video_url, tracks.video_squared_at, tracks.video_vehicle, tracks.video_grain, tracks.video_register, tracks.video_model, tracks.video_model_reasoning, tracks.note, tracks.added_at,
  tracks.updated_at, tracks.vibe_x, tracks.vibe_y, tracks.added_to_spotify, tracks.posted_to_telegram,
  tracks.observation_audio_url, tracks.observation_duration_ms, tracks.observation_generated_at, tracks.observation_alignment_json,
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

/**
 * Parse the stored `observation_alignment_json` into the public caption shape
 * (`{ words: [{ text, startMs, endMs }] }`), or undefined. An empty-words sentinel
 * (the forced-alignment backfill stores `{ words: [] }` to mark a finding handled
 * when the aligner found nothing) surfaces as undefined — no captions to render.
 */
function parseObservationAlignment(
  json: string | null,
): { words: { endMs: number; startMs: number; text: string }[] } | undefined {
  if (!json) {
    return undefined;
  }

  try {
    const raw = JSON.parse(json) as { words?: unknown };

    if (!Array.isArray(raw.words)) {
      return undefined;
    }

    const words = raw.words.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const word = entry as {
        end?: unknown;
        endMs?: unknown;
        start?: unknown;
        startMs?: unknown;
        text?: unknown;
      };
      const text = typeof word.text === "string" ? word.text : "";
      const startMs = finiteOrUndefined(word.startMs);
      const endMs = finiteOrUndefined(word.endMs);

      // Legacy SSML markup tokens (e.g. `<break time="1.0s" />`) can linger in an
      // older observation script, and an aligner tokenises them as "words".
      // They must never render as caption text — drop any token carrying tag markup
      // (`<`, `>`, or an `attr="…"` fragment). Spoken words never contain these, and
      // dropping a break leaves a natural gap (the next word's start is past the pause).
      if (!text || /[<>]|="/.test(text) || startMs === undefined || endMs === undefined) {
        return [];
      }

      return [{ endMs, startMs, text }];
    });

    return words.length > 0 ? { words } : undefined;
  } catch (error) {
    console.warn("parseObservationAlignment: malformed observation_alignment_json column", error);
    return undefined;
  }
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
  } catch (error) {
    console.warn("parseFeatures: malformed features_json column", error);
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

export function toTrackListItem(row: TrackRow): TrackListItem {
  return {
    addedAt: row.added_at,
    addedToSpotify: Boolean(row.added_to_spotify),
    album: row.album ?? undefined,
    albumImageUrl: row.album_image_url ?? undefined,
    artists: parseArtistsJson(row.artists_json),
    bpm: row.bpm ?? undefined,
    discogsReleaseUrl: row.in_release_id ? discogsReleaseUrl(row.in_release_id) : undefined,
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
    observationAlignment: parseObservationAlignment(row.observation_alignment_json),
    // Version the playback URL by the render timestamp so a re-`observe`
    // (which overwrites observation.mp3 in place) re-keys the edge cache — the
    // bare URL alone HITs stale until its max-age TTL. The bare URL stays in the
    // DB column (the admin-overwrite source of truth); only consumers see ?v=.
    observationAudioUrl: versionedObservationAudioUrl(
      row.observation_audio_url ?? undefined,
      row.observation_generated_at ?? undefined,
    ),
    observationDurationMs: row.observation_duration_ms ?? undefined,
    observationGeneratedAt: row.observation_generated_at ?? undefined,
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
    videoGrain: row.video_grain ?? undefined,
    videoModel: row.video_model ?? undefined,
    videoModelReasoning: row.video_model_reasoning ?? undefined,
    videoRegister: row.video_register ?? undefined,
    videoSquaredAt: row.video_squared_at ?? undefined,
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

/**
 * Hydrate a batch of findings by their Log IDs in ONE query (no N+1), keyed by
 * `logId` for O(1) lookup. The edition-email render holds only each finding's tiny
 * `{ logId, why }` reference (the schema keeps it small + current), so the render
 * resolves the live `Artist — Title` + Spotify link from here. A logId with no live
 * finding is simply absent from the map; bound args only, never interpolated.
 */
export async function getTracksByLogIds(logIds: string[]): Promise<Record<string, TrackListItem>> {
  const unique = [...new Set(logIds.filter((id) => id.trim()))];

  if (unique.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await db.execute({
    args: unique,
    sql: `select ${TRACK_SELECT} from tracks where log_id in (${placeholders})`,
  });

  const byLogId: Record<string, TrackListItem> = {};

  for (const row of typedRows<TrackRow>(result.rows)) {
    if (row.log_id) {
      byLogId[row.log_id] = toTrackListItem(row);
    }
  }

  return byLogId;
}

/**
 * Hydrate a batch of findings by their `track_id` in ONE query (no N+1), keyed by
 * `trackId` for O(1) lookup. The plan editor holds each finding only as a cue's
 * `finding_id` (`recording_cues`); this resolves the live `Artist — Title` + cover +
 * BPM/key so the findings builder renders rich rows. A `trackId` with no live finding is
 * simply absent from the map; bound args only, never interpolated.
 */
export async function getTracksByIds(trackIds: string[]): Promise<Record<string, TrackListItem>> {
  const unique = [...new Set(trackIds.filter((id) => id.trim()))];

  if (unique.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await db.execute({
    args: unique,
    sql: `select ${TRACK_SELECT} from tracks where track_id in (${placeholders})`,
  });

  const byTrackId: Record<string, TrackListItem> = {};

  for (const row of typedRows<TrackRow>(result.rows)) {
    byTrackId[row.track_id] = toTrackListItem(row);
  }

  return byTrackId;
}

/**
 * Every coordinate-bearing finding that features an artist, newest-first — the
 * artist page's cover grid (Unit 3, artist-relationship RFC §3). The canonical
 * source is the `track_artists` join; when it returns nothing (an artist not yet
 * backfilled into the join) it falls back to the kept `artists_json` cache,
 * matching the name EXACTLY within the parsed array so a substring like "Sub"
 * can't drag in "Subtronics". A finding with no Log ID never appears (the page is
 * a grid of log links).
 */
export async function getFindingsByArtist(
  artistId: string,
  artistName: string,
): Promise<TrackListItem[]> {
  const db = await getDb();
  const viaJoin = await db.execute({
    args: [artistId],
    sql: `select ${TRACK_SELECT} from tracks
          join track_artists on track_artists.track_id = tracks.track_id
          where track_artists.artist_id = ? and tracks.log_id is not null
          order by tracks.added_at desc, tracks.track_id desc`,
  });

  const joined = typedRows<TrackRow>(viaJoin.rows);

  if (joined.length > 0) {
    return joined.map(toTrackListItem);
  }

  // Fallback: the artist has no track_artists rows yet (pre-backfill). Match the
  // kept display cache, then keep only exact-name members (case-insensitive).
  const needle = artistName.toLowerCase();
  const viaJson = await db.execute({
    args: [needle],
    sql: `select ${TRACK_SELECT} from tracks
          where tracks.log_id is not null
            and lower(tracks.artists_json) like '%' || ? || '%'
          order by tracks.added_at desc, tracks.track_id desc`,
  });

  return typedRows<TrackRow>(viaJson.rows)
    .map(toTrackListItem)
    .filter((finding) => finding.artists.some((name) => name.toLowerCase() === needle));
}

/**
 * Read the INTERNAL `context_note` for a track (the Firecrawl-derived facts).
 * `context_note` is deliberately OUTSIDE `TRACK_SELECT` (internal-only fuel,
 * never surfaced through `toTrackListItem`), so the observe steps read it
 * directly: the `context_track` step skips when it is already present
 * (idempotent no-op), and `observe_track` reads it as the stored fuel it no
 * longer fetches itself. Returns `null` when the track is missing or unset.
 */
export async function getTrackContextNote(idOrLogId: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId],
    sql: `select context_note from tracks where track_id = ? or log_id = ? limit 1`,
  });
  const row = typedRow<{ context_note: string | null }>(result.rows);

  return row ? (row.context_note ?? null) : null;
}

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;

/**
 * Admin free-text search over the findings archive — matches `q` (case-insensitive,
 * substring) against track_id, log_id, title, or any stored artist. Newest-first to
 * mirror listTracks. The artists are stored as a JSON array string (`artists_json`),
 * so we match the raw JSON text — good enough to find an artist by name without
 * unpacking the array. Bound args only; `q` is never interpolated into SQL.
 */
export async function searchTracks(options: {
  q: string;
  limit?: number;
}): Promise<TrackListItem[]> {
  const q = options.q.trim();

  if (!q) {
    return [];
  }

  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? SEARCH_DEFAULT_LIMIT) || SEARCH_DEFAULT_LIMIT, 1),
    SEARCH_MAX_LIMIT,
  );
  const needle = q.toLowerCase();

  const db = await getDb();
  const result = await db.execute({
    args: [needle, needle, needle, needle, limit],
    sql: `select ${TRACK_SELECT}
          from tracks
          where lower(tracks.track_id) like '%' || ? || '%'
             or lower(tracks.log_id) like '%' || ? || '%'
             or lower(tracks.title) like '%' || ? || '%'
             or lower(tracks.artists_json) like '%' || ? || '%'
          order by tracks.added_at desc, tracks.track_id desc
          limit ?`,
  });

  return typedRows<TrackRow>(result.rows).map(toTrackListItem);
}

/**
 * The most-recently-SHIPPED findings — the admin Renders view's "recently shipped"
 * list (the operator's morning render review). Every finding that carries a video,
 * ordered by its video VINTAGE (`video_squared_at`, the two-master ship stamp)
 * newest-first, so a fresh overnight render surfaces at the top even though the
 * finding it filmed is an OLD find (the render queue is worked oldest-first).
 *
 * DISTINCT from `listTracks({ hasVideo: true })`, which orders by FOUND order and so
 * would bury an overnight render of an old find below the newest-added catalogue. A
 * legacy single-master finding (no `video_squared_at`) sorts last — SQLite orders
 * NULLs last under DESC — then by found-order, so the freshest two-master renders
 * always lead.
 */
export async function listRecentlyRenderedFindings(limit: number): Promise<TrackListItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [limit],
    sql: `select ${TRACK_SELECT} from tracks
          where video_url is not null
          order by video_squared_at desc, added_at desc, track_id desc
          limit ?`,
  });

  return typedRows<TrackRow>(result.rows).map(toTrackListItem);
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

/**
 * One random RADIO-ELIGIBLE finding for the cycling station (radio.fluncle.com).
 *
 * Eligible = the finding carries BOTH a clean square master (`video_squared_at`
 * set) AND an observation (`observation_audio_url` set):
 *   - The square master is what radio centre-crops per orientation (media.ts
 *     `videoCrop`) and draws its OWN chrome over, so a legacy baked-text cut must
 *     never reach the station — `video_squared_at` is the two-master signal.
 *   - The observation is the only audio radio plays (the video is silent), so a
 *     finding with no observation has nothing to say.
 * Both predicates are `is not null` filters on this OWN bare query (not the
 * `listTracks` builder), so the endpoint only ever returns a playable finding.
 */
export async function getRandomRadioTrack(): Promise<TrackListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select ${TRACK_SELECT} from tracks
          where tracks.video_squared_at is not null
            and tracks.observation_audio_url is not null
          order by random() limit 1`,
  });
  const row = typedRow<TrackRow>(result.rows);

  return row ? toTrackListItem(row) : undefined;
}

// ── radio.fluncle.com — the shared schedule (RFC radio-broadcast.md, Unit A) ──

/**
 * The radio loop's eligible findings, deterministically ordered. The eligibility
 * predicate matches `getRandomRadioTrack` (a clean square master + an observation)
 * PLUS `observation_duration_ms`/`log_id` non-null — the schedule arithmetic needs
 * the segment length (the audio IS the clock) and the URL builder needs the logId,
 * where the random op tolerated their absence by skipping client-side.
 *
 * The order is found-order — `added_at ASC, track_id ASC`, the codebase's
 * canonical stable total order (the feed cursor, neighbors, and search tiebreak
 * all use this tuple). It MUST NOT be `random()` — that is exactly what breaks
 * synchronization. A non-found shuffle (Decision #2) would be a stable
 * epoch-seeded permutation in the handler; the SQL stays deterministic either way.
 */
export async function getRadioEligibleTracks(): Promise<RadioScheduleEntry[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select track_id, log_id, observation_duration_ms
          from tracks
          where video_squared_at is not null
            and observation_audio_url is not null
            and observation_duration_ms is not null
            and log_id is not null
          order by added_at asc, track_id asc`,
  });

  return typedRows<{
    log_id: string;
    observation_duration_ms: number;
    track_id: string;
  }>(result.rows).map((row) => ({
    logId: row.log_id,
    observationDurationMs: row.observation_duration_ms,
    trackId: row.track_id,
  }));
}

/**
 * A cheap fingerprint of the eligible set — `${count}:${maxObservationGeneratedAt}`
 * over the SAME predicate as `getRadioEligibleTracks`. `count` rises on a new
 * eligible finding; `latest` (the max `observation_generated_at`) moves on a
 * re-observe (a changed duration). A different fingerprint is the "the schedule
 * changed" trigger that rolls the epoch to the next loop boundary — computed on
 * the READ path, so the eligibility-changing agent writes never touch the anchor.
 */
export async function getRadioScheduleFingerprint(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select count(*) as count,
                 coalesce(max(observation_generated_at), '') as latest
          from tracks
          where video_squared_at is not null
            and observation_audio_url is not null
            and observation_duration_ms is not null
            and log_id is not null`,
  });
  const row = typedRow<{ count: number; latest: string }>(result.rows);

  return `${Number(row?.count ?? 0)}:${row?.latest ?? ""}`;
}

type RadioScheduleRow = {
  epoch_ms: number;
  version: string;
};

/**
 * Read the stored schedule anchor, ROLLING it to the next loop boundary when the
 * eligible set changed (a self-heal on the read path). Returns the live epoch the
 * modulo math is measured from plus the fingerprint clients re-fetch on.
 *
 * On a fingerprint mismatch (or a first-ever read), the new schedule is made to
 * take effect at the NEXT loop boundary of the OLD loop (`nextBoundaryEpochMs`),
 * so a grown/re-observed catalogue applies at a seam and no current listener's
 * playhead jumps mid-loop — then the row is upserted. `oldEntries` lets the caller
 * pass the freshly-read eligible set so the boundary roll uses the OLD loop length
 * the listeners are still riding (the caller reads the live set anyway).
 */
export async function getRadioScheduleAnchor(
  version: string,
  oldLoopDurationMs: number,
  nowMs: number = Date.now(),
): Promise<{ epochMs: number; version: string }> {
  const db = await getDb();
  const stored = typedRow<RadioScheduleRow>(
    (
      await db.execute({
        args: ["radio"],
        sql: `select epoch_ms, version from radio_schedule where service = ?`,
      })
    ).rows,
  );

  // The anchor still matches the live set — nothing to roll.
  if (stored && stored.version === version) {
    return { epochMs: stored.epoch_ms, version };
  }

  // First-ever read: anchor at now. A changed set: roll the OLD epoch to the next
  // boundary of the OLD loop so the new schedule applies at a seam.
  const epochMs = stored ? nextBoundaryEpochMs(stored.epoch_ms, oldLoopDurationMs, nowMs) : nowMs;
  const generatedAt = new Date(nowMs).toISOString();

  await db.execute({
    args: [epochMs, generatedAt, version],
    sql: `insert into radio_schedule (service, epoch_ms, generated_at, version)
          values ('radio', ?, ?, ?)
          on conflict(service) do update set
            epoch_ms = excluded.epoch_ms,
            generated_at = excluded.generated_at,
            version = excluded.version`,
  });

  return { epochMs, version };
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

type EmbeddingRow = {
  embedding_json: string;
  track_id: string;
};

/**
 * The N sonically-nearest findings to a given one — the automatic "more like this"
 * cluster (docs/audio-embedding-rfc.md, Phase 1). Loads the target's MuQ embedding,
 * cosine-ranks it against every OTHER coordinate-bearing finding's embedding, and
 * hydrates the winners in similarity order. Powers the `/log` "more like this" row and
 * the public `get_similar_findings` op; a future "play something like this" radio hook
 * reads the same function.
 *
 * Returns `[]` (never throws) when the finding is unknown, has no embedding yet
 * (`embedding_json IS NULL` — the embed cron hasn't drained it), or nothing else is
 * embedded. Brute-force cosine over the whole embedded set is instant at the
 * catalogue's scale (dozens → low thousands); libSQL `vector_top_k` is the escape
 * hatch past ~10k. Only coordinate-bearing candidates (`log_id IS NOT NULL`) are
 * considered — every result links to a `/log` page — and the target is excluded.
 */
export async function getSimilarFindings(idOrLogId: string, limit = 6): Promise<TrackListItem[]> {
  if (limit <= 0) {
    return [];
  }

  const db = await getDb();
  const targetResult = await db.execute({
    args: [idOrLogId, idOrLogId],
    sql: `select track_id, embedding_json from tracks where track_id = ? or log_id = ? limit 1`,
  });
  const targetRow = typedRow<{ embedding_json: string | null; track_id: string }>(
    targetResult.rows,
  );

  if (!targetRow) {
    return [];
  }

  const target = parseEmbedding(targetRow.embedding_json);

  if (!target) {
    return [];
  }

  const candidateResult = await db.execute({
    args: [targetRow.track_id],
    sql: `select track_id, embedding_json from tracks
          where log_id is not null and embedding_json is not null and track_id != ?`,
  });

  const candidates: EmbeddingCandidate<string>[] = [];

  for (const row of typedRows<EmbeddingRow>(candidateResult.rows)) {
    const embedding = parseEmbedding(row.embedding_json);

    if (embedding) {
      candidates.push({ embedding, item: row.track_id });
    }
  }

  const topIds = rankBySimilarity(target, candidates, limit);

  if (topIds.length === 0) {
    return [];
  }

  // Hydrate the winners in ONE batched query, then re-order to the ranking (the map
  // is by trackId, unordered). A winner that vanished between the two reads is dropped.
  const byId = await getTracksByIds(topIds);

  return topIds.flatMap((id) => {
    const item = byId[id];
    return item ? [item] : [];
  });
}

type TrackCountRow = {
  total_count: number;
};

/**
 * How long a track may sit in `processing` before the enrich-queue treats it as
 * stuck (the box rebooted mid-run, etc.) and re-picks it. Enrichment is a
 * multi-minute job, so 30 min is comfortably longer than a healthy run; a row
 * that's been "processing" past it is presumed dead, not in-flight. The
 * idempotency key (`enrich:${logId}`) makes a wrongly-early re-pick harmless —
 * an in-flight run is de-duped rather than duplicated.
 */
export const ENRICH_STALE_PROCESSING_MS = 30 * 60 * 1000;

/**
 * Enrichment state filters. The four are the real `enrichment_status` values;
 * `"queue"` is the SELF-HEALING meta-filter the sweep uses: tracks NEEDING
 * (re-)enrichment = pending ∪ failed ∪ STALE processing (a `processing` row
 * older than ENRICH_STALE_PROCESSING_MS, including rows with no updated_at).
 * Filtering on only pending/failed would never re-pick a box-rebooted
 * `processing` track — the most common failure — so "queue" must include it.
 */
export type EnrichmentStatusFilter = "pending" | "processing" | "done" | "failed" | "queue";

export const ENRICHMENT_STATUS_FILTERS: readonly EnrichmentStatusFilter[] = [
  "pending",
  "processing",
  "done",
  "failed",
  "queue",
];

type ListTracksOptions = {
  cursor?: TrackCursor;
  /**
   * Context-fetch state (admin only) — the `context_track` queue's filter.
   * `false` = the queue: findings still NEEDING a context fetch. Status-aware so a
   * CONFIRMED-EMPTY fetch is not re-burned every tick: it matches `context_status`
   * pending ∪ failed ∪ NULL (never-attempted rows that predate the column read NULL
   * and count as pending), but NOT `empty`/`resolved`. `true` = already resolved
   * (`context_note IS NOT NULL`). Internal field, never surfaced; omitted for
   * public reads. Pair `false` with `retryEmptyContext` to also re-pick `empty`.
   */
  hasContext?: boolean;
  /**
   * Audio-embedding presence (admin only) — the MuQ embed queue's filter.
   * `false` = `embedding_json IS NULL` (no MuQ vector yet — the `fluncle-embed`
   * cron's worklist); `true` = a vector is on file. Omitted for public reads.
   * Mirrors `hasVideo`/`hasKey`'s tri-state. See docs/audio-embedding-rfc.md.
   */
  hasEmbedding?: boolean;
  /**
   * Observation presence (admin only) — the observation queue's filter.
   * `false` = `observation_audio_url IS NULL` (no spoken observation yet);
   * `true` = already minted. The observation queue is `hasContext=true AND
   * hasObservation=false`. Omitted for public reads.
   */
  hasObservation?: boolean;
  /**
   * Editorial-note presence (admin only) — the auto-note queue's filter.
   * `false` = `note IS NULL OR note = ''` (no editorial note yet — the queue);
   * `true` = a note is on file. The note queue is `hasContext=true AND hasNote=false`
   * (a finding with the context_note fuel but no written note yet). Omitted for
   * public reads.
   */
  hasNote?: boolean;
  /**
   * Musical-key presence (admin only) — the Rekordbox key-backfill's queue.
   * `false` = `key IS NULL` (no stored key yet: the DSP left it null below its
   * confidence floor — the missing-key backlog the backfill targets); `true` = a
   * key is on file. Omitted for public reads. Mirrors `hasVideo`'s tri-state.
   */
  hasKey?: boolean;
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
  /**
   * Widen the `hasContext=false` context queue to also re-pick CONFIRMED-EMPTY
   * finds (`context_status = 'empty'`) — the `--retry-empty` escape hatch for when
   * a query/source fix means a previously-hopeless find might now resolve. No
   * effect unless `hasContext === false`. Omitted for public reads.
   */
  retryEmptyContext?: boolean;
  since?: string;
  /**
   * Enrichment-state filter (admin only). A bare status matches that exact
   * `enrichment_status`; "queue" matches everything needing (re-)enrichment —
   * pending ∪ failed ∪ stale processing — and is what the enrich-queue + sweep
   * read. Omitted for public reads.
   */
  status?: EnrichmentStatusFilter;
  until?: string;
};

export function listTracks(
  options: ListTracksOptions & { includeMixtapes: true },
): Promise<FeedListPage>;
export function listTracks(options: ListTracksOptions): Promise<TrackListPage>;
export async function listTracks({
  cursor,
  hasContext,
  hasEmbedding,
  hasKey,
  hasNote,
  hasObservation,
  hasVideo,
  includeMixtapes = false,
  limit,
  order = "desc",
  placement,
  retryEmptyContext = false,
  since,
  status,
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

  // The key-backfill queue: `key IS NULL` (no stored musical key — the DSP left it
  // null below its confidence floor). `true` = a key is on file. Mirrors hasVideo.
  if (hasKey === true) {
    filterClauses.push("key is not null");
  } else if (hasKey === false) {
    filterClauses.push("key is null");
  }

  // The MuQ embed queue: `embedding_json IS NULL` (no audio embedding yet — the
  // `fluncle-embed` cron's worklist). `true` = a vector is on file. Mirrors hasKey.
  if (hasEmbedding === true) {
    filterClauses.push("embedding_json is not null");
  } else if (hasEmbedding === false) {
    filterClauses.push("embedding_json is null");
  }

  // The context queue. `true` = resolved (a note is stored). `false` = the work
  // queue: findings still needing a fetch — no note yet AND `context_status`
  // pending/failed/NULL (NULL = never-attempted rows that predate the column), but
  // NOT `empty` so a confirmed-empty find is not re-burned every tick. The
  // `context_note IS NULL` guard also keeps a legacy resolved-but-unmarked row (note
  // present, status NULL) out of the queue. `retryEmptyContext` widens it to also
  // re-pick `empty` (the `--retry-empty` escape hatch).
  if (hasContext === true) {
    filterClauses.push("context_note is not null");
  } else if (hasContext === false) {
    filterClauses.push(
      retryEmptyContext
        ? "(context_note is null and (context_status is null or context_status in ('pending', 'failed', 'empty')))"
        : "(context_note is null and (context_status is null or context_status in ('pending', 'failed')))",
    );
  }

  // The observation queue: `observation_audio_url IS NULL` (no spoken
  // observation). Paired with hasContext=true it is the "ready to observe" queue.
  if (hasObservation === true) {
    filterClauses.push("observation_audio_url is not null");
  } else if (hasObservation === false) {
    filterClauses.push("observation_audio_url is null");
  }

  // The auto-note queue: `note IS NULL OR note = ''` (no editorial note yet). Paired
  // with hasContext=true it is the "ready to author a note" queue — a finding with
  // the context_note fuel but an empty `note`. The empty-string guard matches the
  // fill-empty-only semantics of note_track (a whitespace note is still empty).
  if (hasNote === true) {
    filterClauses.push("(note is not null and trim(note) != '')");
  } else if (hasNote === false) {
    filterClauses.push("(note is null or trim(note) = '')");
  }

  if (placement === "unplaced") {
    filterClauses.push("vibe_x is null");
  } else if (placement === "placed") {
    filterClauses.push("vibe_x is not null");
  }

  if (status === "queue") {
    // The self-healing enrich-queue: pending ∪ failed ∪ STALE processing. A
    // `processing` row counts as stuck once it's older than the staleness
    // threshold (updated_at is bumped to the processing transition — enrichment
    // status is a visible field in track-update.ts) OR has a null updated_at
    // (predates the column). Bound arg only; never string-concatenated.
    const staleCutoff = new Date(Date.now() - ENRICH_STALE_PROCESSING_MS).toISOString();
    filterClauses.push(
      "(enrichment_status in ('pending', 'failed') or (enrichment_status = 'processing' and (updated_at is null or updated_at < ?)))",
    );
    filterArgs.push(staleCutoff);
  } else if (status) {
    filterClauses.push("enrichment_status = ?");
    filterArgs.push(status);
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
    includeMixtapes &&
    !since &&
    !until &&
    hasVideo === undefined &&
    placement === undefined &&
    status === undefined
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
            m.duration_ms,
            m.note,
            (select url from mixtape_social_posts s
               where s.mixtape_id = m.id and s.platform = 'mixcloud' and s.status = 'published' and s.url is not null
               order by published_at desc limit 1) as mixcloud_url,
            (select url from mixtape_social_posts s
               where s.mixtape_id = m.id and s.platform = 'youtube' and s.status = 'published' and s.url is not null
               order by published_at desc limit 1) as youtube_url,
            (select url from mixtape_social_posts s
               where s.mixtape_id = m.id and s.platform = 'soundcloud' and s.status = 'published' and s.url is not null
               order by published_at desc limit 1) as soundcloud_url,
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
 * it. Whole-set fetch is fine at this scale; cluster it when the map gets busy.
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

export function encodeTrackCursor(cursor: TrackCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
