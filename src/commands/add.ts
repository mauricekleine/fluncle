import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { tracks } from "../db/schema";
import { formatError, withRetries } from "../retry";
import { addTrackToPlaylist, fetchTrackMetadata, parseSpotifyTrackUrl } from "../spotify";
import { formatTelegramMessage, postToTelegram } from "../telegram";

type AddOptions = {
  note?: string;
  dryRun?: boolean;
};

export async function addCommand(spotifyUrl: string, options: AddOptions): Promise<void> {
  const trackId = parseSpotifyTrackUrl(spotifyUrl);
  const [existing] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.trackId, trackId))
    .limit(1);

  if (existing) {
    const existingArtists = JSON.parse(existing.artistsJson) as string[];
    const existingLine = `${existingArtists.join(", ")} — ${existing.title}`;

    if (existing.addedToSpotify && existing.postedToTelegram) {
      throw new Error(`Already published: ${existingLine}`);
    }

    throw new Error(`Already attempted but incomplete:

${existingLine}

${existing.addedToSpotify ? "✅" : "❌"} Added to Spotify
${existing.postedToTelegram ? "✅" : "❌"} Posted to Telegram`);
  }

  const track = await fetchTrackMetadata(trackId);
  const artistLine = `${track.artists.join(", ")} — ${track.title}`;

  if (options.dryRun) {
    console.log(`Dry run

${artistLine}
Album: ${track.album ?? "Unknown"}
Duration: ${formatDuration(track.durationMs)}
Spotify: ${track.spotifyUrl}

Telegram message:

${formatTelegramMessage(track, options.note)}

No database, Spotify, or Telegram changes were made.`);
    return;
  }

  await db.insert(tracks).values({
    trackId: track.trackId,
    spotifyUrl: track.spotifyUrl,
    spotifyUri: track.spotifyUri,
    title: track.title,
    artistsJson: JSON.stringify(track.artists),
    album: track.album,
    durationMs: track.durationMs,
    note: options.note,
    addedAt: new Date().toISOString(),
    addedToSpotify: false,
    postedToTelegram: false,
  });

  try {
    await withRetries("Spotify playlist add", () => addTrackToPlaylist(track));
  } catch (error) {
    const message = formatError(error);
    await db
      .update(tracks)
      .set({ spotifyError: message })
      .where(eq(tracks.trackId, track.trackId));

    throw new Error(`Spotify failed. Telegram was not posted.\n${message}`);
  }

  try {
    await db
      .update(tracks)
      .set({
        addedToSpotify: true,
        addedToSpotifyAt: new Date().toISOString(),
        spotifyError: null,
      })
      .where(eq(tracks.trackId, track.trackId));
  } catch (error) {
    throw new Error(
      `Spotify succeeded, but the database update failed. Telegram was not posted.\n${formatError(error)}`,
    );
  }

  try {
    await withRetries("Telegram post", () => postToTelegram(track, options.note));
  } catch (error) {
    const message = formatError(error);
    await db
      .update(tracks)
      .set({ telegramError: message })
      .where(eq(tracks.trackId, track.trackId));

    throw new Error(`Spotify succeeded, but Telegram failed.\n${message}`);
  }

  try {
    await db
      .update(tracks)
      .set({
        postedToTelegram: true,
        postedToTelegramAt: new Date().toISOString(),
        telegramError: null,
      })
      .where(eq(tracks.trackId, track.trackId));
  } catch (error) {
    throw new Error(`Telegram posted, but the database update failed.\n${formatError(error)}`);
  }

  console.log(`📻 Transmission sent

${artistLine}

✅ Added to Spotify
✅ Posted to Telegram`);
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
