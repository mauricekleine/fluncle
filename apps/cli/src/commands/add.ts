import { db } from "../db/client";
import { CliError } from "../output";
import { formatError, withRetries } from "../retry";
import { addTrackToPlaylist, fetchTrackMetadata, parseSpotifyTrackUrl } from "../spotify";
import { formatTelegramMessage, postToTelegram } from "../telegram";

type AddOptions = {
  note?: string;
  dryRun?: boolean;
  json?: boolean;
};

export type AddCommandResult = {
  track: {
    trackId: string;
    spotifyUrl: string;
    title: string;
    artists: string[];
    album?: string;
    durationMs: number;
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

export async function addCommand(
  spotifyUrl: string,
  options: AddOptions,
): Promise<AddCommandResult> {
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
      throw new CliError("duplicate", `Already published: ${existingLine}`);
    }

    throw new CliError(
      "incomplete_duplicate",
      `Already attempted but incomplete:

${existingLine}

${existing.added_to_spotify ? "✅" : "❌"} Added to Spotify
${existing.posted_to_telegram ? "✅" : "❌"} Posted to Telegram`,
    );
  }

  const track = await fetchTrackMetadata(trackId);
  const artistLine = `${track.artists.join(", ")} — ${track.title}`;

  if (options.dryRun) {
    const message = `Dry run

${artistLine}
Album: ${track.album ?? "Unknown"}
Duration: ${formatDuration(track.durationMs)}
Spotify: ${track.spotifyUrl}

Telegram message:

${formatTelegramMessage(track, options.note)}

No database, Spotify, or Telegram changes were made.`;

    if (!options.json) {
      console.log(message);
    }

    return buildAddResult(track, message, {
      addedToSpotify: false,
      dryRun: true,
      postedToTelegram: false,
    });
  }

  await db.execute({
    args: [
      track.trackId,
      track.spotifyUrl,
      track.spotifyUri,
      track.title,
      JSON.stringify(track.artists),
      track.album ?? null,
      track.durationMs,
      options.note ?? null,
      new Date().toISOString(),
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
        duration_ms,
        note,
        added_at,
        added_to_spotify,
        posted_to_telegram
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  try {
    await withRetries("Spotify playlist add", () => addTrackToPlaylist(track));
  } catch (error) {
    const message = formatError(error);
    await db.execute({
      args: [message, track.trackId],
      sql: `update tracks set spotify_error = ? where track_id = ?`,
    });

    throw new CliError("spotify_failed", `Spotify failed. Telegram was not posted.\n${message}`);
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
    throw new CliError(
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

    throw new CliError("telegram_failed", `Spotify succeeded, but Telegram failed.\n${message}`);
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
    throw new CliError(
      "db_update_failed",
      `Telegram posted, but the database update failed.\n${formatError(error)}`,
    );
  }

  const message = `📻 Transmission sent

${artistLine}

✅ Added to Spotify
✅ Posted to Telegram`;

  if (!options.json) {
    console.log(message);
  }

  return buildAddResult(track, message, {
    addedToSpotify: true,
    dryRun: false,
    postedToTelegram: true,
  });
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
): AddCommandResult {
  return {
    addedToSpotify: status.addedToSpotify,
    dryRun: status.dryRun,
    message,
    postedToTelegram: status.postedToTelegram,
    track: {
      album: track.album,
      artists: track.artists,
      durationMs: track.durationMs,
      spotifyUrl: track.spotifyUrl,
      title: track.title,
      trackId: track.trackId,
    },
  };
}
