import { type PublishTrackResult } from "@fluncle/contracts";

export type { PublishTrackResult };

import { logPageUrl } from "../fluncle-links";
import { formatDuration } from "../format";
import { parseArtistsJson, upsertTrackArtists } from "./artists";
import { getDb, typedRow } from "./db";
import { enrichFromDeezer, lookupIsrcFromDeezer } from "./deezer";
import { discogsResolveRelease } from "./discogs";
import { purgeLogCache } from "./edge-cache";
import { submitFindingToIndexNow } from "./indexnow";
import { lastfmLove } from "./lastfm";
import { resolveLogId } from "./log-id";
import { notifyNewFinding } from "./push";
import { formatError, withRetries } from "./retry";
import {
  addTrackToPlaylist,
  ApiError,
  fetchTrackMetadata,
  parseSpotifyTrackUrl,
  SPOTIFY_REAUTH_REQUIRED,
} from "./spotify";
import { formatTelegramMessage, postToTelegram } from "./telegram";

type AddOptions = {
  note?: string;
  dryRun?: boolean;
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
): Promise<PublishTrackResult> {
  const db = await getDb();
  const trackId = parseSpotifyTrackUrl(spotifyUrl);
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select track_id, title, artists_json, added_to_spotify, posted_to_telegram
      from tracks
      where track_id = ?
      limit 1`,
  });
  const existing = typedRow<TrackRow>(existingResult.rows);

  if (existing) {
    const existingArtists = parseArtistsJson(existing.artists_json);
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

  // ISRC fallback (the track-add gap): Spotify occasionally
  // omits the ISRC; Deezer usually carries it. Looked up BEFORE the Log ID is
  // computed so the coordinate hashes from the recording's real identity, and
  // the Deezer enrichment below (label + preview, keyed by ISRC) works too.
  if (!track.isrc?.trim()) {
    track.isrc = await lookupIsrcFromDeezer(track);
  }

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

${formatTelegramMessage(track, options.note, logId)}

No database, Spotify, or Telegram changes were made. Enrichment (label, preview) runs on publish.`;

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
  // video) are filled later by the async enrichment agent; the vibe placement is
  // set by an admin in the tagging tool.
  const deezer = await enrichFromDeezer(track.isrc);

  // Read-only Discogs release-ID enrichment (best-effort, alongside the Deezer
  // label/preview it most resembles — both cheap HTTP, Worker-safe). A scored
  // cascade with a tracklist-confirm gate (MusicBrainz ISRC bridge first, then a
  // gated Discogs search): it stores an id ONLY on a high-confidence match and
  // leaves the ids null otherwise — a wrong id is worse than a missing one. The
  // `discogs.com/release/{id}` URL becomes a per-finding `sameAs`.
  // discogsResolveRelease swallows its own errors and no-ops without the token, so
  // a miss never blocks the add — same side-channel discipline as Deezer. The
  // Deezer label feeds the labelSim signal.
  const discogs = await discogsResolveRelease({
    album: track.album,
    artists: track.artists,
    isrc: track.isrc,
    label: deezer.label,
    releaseDate: track.releaseDate,
    title: track.title,
  });

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
      discogs.releaseId ?? null,
      discogs.masterId ?? null,
      options.note ?? null,
      nowIso,
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
        in_release_id,
        in_master_id,
        note,
        added_at,
        updated_at,
        added_to_spotify,
        posted_to_telegram
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  // Best-effort: populate the artist entity tables (artists + track_artists) so
  // the identity graph is ready for the resolution sweep. Uses the artist IDs
  // Spotify returns on the track response (no extra API call). A failure here
  // must never block the publish — same discipline as the Deezer / Last.fm side
  // channels; the backfill covers any rows a failed call leaves behind.
  try {
    await upsertTrackArtists(track.trackId, track.artists, track.spotifyArtistIds);
  } catch (artistError) {
    console.warn("publishTrack: artist entity upsert failed (non-fatal)", artistError);
  }

  try {
    await withRetries("Spotify playlist add", () => addTrackToPlaylist(track));
  } catch (error) {
    const message = formatError(error);
    await db.execute({
      args: [message, new Date().toISOString(), track.trackId],
      sql: `update tracks set spotify_error = ?, updated_at = ? where track_id = ?`,
    });

    // An expired Spotify authorization is an actionable "reconnect", not a generic
    // failure — pass it through verbatim so the operator sees the reconnect path.
    if (error instanceof ApiError && error.code === SPOTIFY_REAUTH_REQUIRED) {
      throw error;
    }

    throw new ApiError("spotify_failed", `Spotify failed. Telegram was not posted.\n${message}`);
  }

  try {
    await db.execute({
      args: [new Date().toISOString(), new Date().toISOString(), track.trackId],
      sql: `update tracks
        set added_to_spotify = 1,
          added_to_spotify_at = ?,
          spotify_error = null,
          updated_at = ?
        where track_id = ?`,
    });
  } catch (error) {
    throw new ApiError(
      "db_update_failed",
      `Spotify succeeded, but the database update failed. Telegram was not posted.\n${formatError(error)}`,
    );
  }

  try {
    await withRetries("Telegram post", () => postToTelegram(track, options.note, logId));
  } catch (error) {
    const message = formatError(error);
    await db.execute({
      args: [message, new Date().toISOString(), track.trackId],
      sql: `update tracks set telegram_error = ?, updated_at = ? where track_id = ?`,
    });

    throw new ApiError("telegram_failed", `Spotify succeeded, but Telegram failed.\n${message}`);
  }

  try {
    await db.execute({
      args: [new Date().toISOString(), new Date().toISOString(), track.trackId],
      sql: `update tracks
        set posted_to_telegram = 1,
          posted_to_telegram_at = ?,
          telegram_error = null,
          updated_at = ?
        where track_id = ?`,
    });
  } catch (error) {
    throw new ApiError(
      "db_update_failed",
      `Telegram posted, but the database update failed.\n${formatError(error)}`,
    );
  }

  // A new finding now sits at the top of the `/log` index (and owns its own
  // coordinate page): drop both from the edge cache so they re-render with it.
  purgeLogCache(logId);
  // Best-effort endorsement: love the finding on Last.fm (a Loved Track, not a
  // scrobble — see lastfm.ts / the RFC). A single signed HTTPS call, Worker-safe.
  // Never blocks or fails the add — same side-channel discipline as Deezer/Telegram:
  // lastfmLove swallows its own errors and no-ops when Last.fm isn't provisioned.
  await lastfmLove(track.artists[0] ?? track.artists.join(", "), track.title);
  // Best-effort: notify the mobile crew a fresh banger is live (push.ts). Gated on
  // EXPO_ACCESS_TOKEN — a NO-OP until configured — and fire-and-forget (waitUntil):
  // it NEVER throws and NEVER blocks/fails the publish, same discipline as above.
  // The duplicate/incomplete_duplicate guards above throw before this hook, so a
  // retry can't re-reach it — no extra gate needed.
  notifyNewFinding(track, logId);
  // Best-effort: ping IndexNow (Bing/Yandex + the shared network) so the fresh
  // log page is crawled within minutes (indexnow.ts). Fire-and-forget via
  // waitUntil; the key is a PUBLIC ownership token, so this needs no operator
  // secret and NEVER throws or blocks the publish — same discipline as above.
  submitFindingToIndexNow(logId);

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

function buildAddResult(
  track: Awaited<ReturnType<typeof fetchTrackMetadata>>,
  message: string,
  status: {
    dryRun: boolean;
    addedToSpotify: boolean;
    postedToTelegram: boolean;
  },
  extra: { logId?: string; label?: string; previewUrl?: string } = {},
): PublishTrackResult {
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
      logPageUrl: extra.logId ? logPageUrl(extra.logId) : undefined,
      popularity: track.popularity,
      previewUrl: extra.previewUrl,
      spotifyUrl: track.spotifyUrl,
      title: track.title,
      trackId: track.trackId,
    },
  };
}
