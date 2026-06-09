import { getDb } from "./db";
import { enrichFromDeezer } from "./deezer";
import { resolveLogId } from "./log-id";
import { formatError, withRetries } from "./retry";
import { addTrackToPlaylist, ApiError, fetchTrackMetadata, parseSpotifyTrackUrl } from "./spotify";
import { formatTelegramMessage, postToTelegram } from "./telegram";

type AddOptions = {
  note?: string;
  dryRun?: boolean;
};

export type AddTrackResult = {
  track: {
    trackId: string;
    spotifyUrl: string;
    title: string;
    artists: string[];
    album?: string;
    albumImageUrl?: string;
    durationMs: number;
    logId?: string;
    isrc?: string;
    label?: string;
    previewUrl?: string;
    popularity?: number;
    tags?: string[];
  };
  dryRun: boolean;
  addedToSpotify: boolean;
  postedToTelegram: boolean;
  message: string;
};

type TrackRow = {
  track_id: string;
  title: string;
  artists_json: string;
  added_to_spotify: number;
  posted_to_telegram: number;
};

export async function publishTrack(
  spotifyUrl: string,
  options: AddOptions,
): Promise<AddTrackResult> {
  const db = await getDb();
  const trackId = parseSpotifyTrackUrl(spotifyUrl);
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select track_id, title, artists_json, added_to_spotify, posted_to_telegram
      from tracks
      where track_id = ?
      limit 1`,
  });
  const existing = existingResult.rows[0] as unknown as TrackRow | undefined;

  if (existing) {
    const existingArtists = JSON.parse(existing.artists_json) as string[];
    const existingLine = `${existingArtists.join(", ")} — ${existing.title}`;

    if (existing.added_to_spotify && existing.posted_to_telegram) {
      throw new ApiError("duplicate", `Already published: ${existingLine}`, 409);
    }

    throw new ApiError(
      "incomplete_duplicate",
      `Already attempted but incomplete:

${existingLine}

${existing.added_to_spotify ? "Added to Spotify" : "Not added to Spotify"}
${existing.posted_to_telegram ? "Posted to Telegram" : "Not posted to Telegram"}`,
      409,
    );
  }

  const track = await fetchTrackMetadata(trackId);
  const artistLine = `${track.artists.join(", ")} — ${track.title}`;
  const nowIso = new Date().toISOString();

  // The permanent Galaxy coordinate: deterministic from the found date + the
  // recording's ISRC (Spotify id as fallback); a rare collision resolves to a
  // fresh tail on the same sector. Computed even on dry run so the operator can
  // preview the coordinate.
  const logId = await resolveLogId(
    { foundAt: nowIso, isrc: track.isrc, trackId: track.trackId },
    async (candidate) => {
      const taken = await db.execute({
        args: [candidate],
        sql: `select 1 from tracks where log_id = ? limit 1`,
      });

      return taken.rows.length > 0;
    },
  );

  if (options.dryRun) {
    const message = `Dry run

${artistLine}
Log ID: fluncle://${logId}
Album: ${track.album ?? "Unknown"}
Duration: ${formatDuration(track.durationMs)}
Spotify: ${track.spotifyUrl}

Telegram message:

${formatTelegramMessage(track, options.note)}

No database, Spotify, or Telegram changes were made. Enrichment (label, preview, tags) runs on publish.`;

    return buildAddResult(
      track,
      message,
      {
        addedToSpotify: false,
        dryRun: true,
        postedToTelegram: false,
      },
      { logId },
    );
  }

  // Sync enrichment: HTTP-only and best-effort (label + preview from Deezer), so
  // a miss never blocks the publish. The heavy, audio-derived fields (bpm, key,
  // tags, video) are filled later by the async enrichment agent, and tags can be
  // set/overridden by an admin — see docs/track-lifecycle.md.
  const deezer = await enrichFromDeezer(track.isrc);

  await db.execute({
    args: [
      track.trackId,
      track.spotifyUrl,
      track.spotifyUri,
      track.title,
      JSON.stringify(track.artists),
      track.album ?? null,
      track.albumImageUrl ?? null,
      track.releaseDate ?? null,
      track.durationMs,
      track.isrc ?? null,
      deezer.label ?? null,
      logId,
      track.popularity ?? null,
      deezer.previewUrl ?? null,
      null,
      options.note ?? null,
      nowIso,
      0,
      0,
    ],
    sql: `insert into tracks (
        track_id,
        spotify_url,
        spotify_uri,
        title,
        artists_json,
        album,
        album_image_url,
        release_date,
        duration_ms,
        isrc,
        label,
        log_id,
        popularity,
        preview_url,
        tags_json,
        note,
        added_at,
        added_to_spotify,
        posted_to_telegram
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  try {
    await withRetries("Spotify playlist add", () => addTrackToPlaylist(track));
  } catch (error) {
    const message = formatError(error);
    await db.execute({
      args: [message, track.trackId],
      sql: `update tracks set spotify_error = ? where track_id = ?`,
    });

    throw new ApiError("spotify_failed", `Spotify failed. Telegram was not posted.\n${message}`);
  }

  try {
    await db.execute({
      args: [new Date().toISOString(), track.trackId],
      sql: `update tracks
        set added_to_spotify = 1,
          added_to_spotify_at = ?,
          spotify_error = null
        where track_id = ?`,
    });
  } catch (error) {
    throw new ApiError(
      "db_update_failed",
      `Spotify succeeded, but the database update failed. Telegram was not posted.\n${formatError(error)}`,
    );
  }

  try {
    await withRetries("Telegram post", () => postToTelegram(track, options.note));
  } catch (error) {
    const message = formatError(error);
    await db.execute({
      args: [message, track.trackId],
      sql: `update tracks set telegram_error = ? where track_id = ?`,
    });

    throw new ApiError("telegram_failed", `Spotify succeeded, but Telegram failed.\n${message}`);
  }

  try {
    await db.execute({
      args: [new Date().toISOString(), track.trackId],
      sql: `update tracks
        set posted_to_telegram = 1,
          posted_to_telegram_at = ?,
          telegram_error = null
        where track_id = ?`,
    });
  } catch (error) {
    throw new ApiError(
      "db_update_failed",
      `Telegram posted, but the database update failed.\n${formatError(error)}`,
    );
  }

  const message = `Banger logged

${artistLine}

Added to Spotify
Posted to Telegram`;

  return buildAddResult(
    track,
    message,
    {
      addedToSpotify: true,
      dryRun: false,
      postedToTelegram: true,
    },
    { label: deezer.label, logId, previewUrl: deezer.previewUrl },
  );
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function buildAddResult(
  track: Awaited<ReturnType<typeof fetchTrackMetadata>>,
  message: string,
  status: {
    dryRun: boolean;
    addedToSpotify: boolean;
    postedToTelegram: boolean;
  },
  extra: { logId?: string; label?: string; previewUrl?: string } = {},
): AddTrackResult {
  return {
    addedToSpotify: status.addedToSpotify,
    dryRun: status.dryRun,
    message,
    postedToTelegram: status.postedToTelegram,
    track: {
      album: track.album,
      albumImageUrl: track.albumImageUrl,
      artists: track.artists,
      durationMs: track.durationMs,
      isrc: track.isrc,
      label: extra.label,
      logId: extra.logId,
      popularity: track.popularity,
      previewUrl: extra.previewUrl,
      spotifyUrl: track.spotifyUrl,
      title: track.title,
      trackId: track.trackId,
    },
  };
}
