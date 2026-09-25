import { type InStatement } from "@libsql/client/web";
import { type PublishTrackResult } from "@fluncle/contracts";

export type { PublishTrackResult };

import { logPageUrl } from "../fluncle-links";
import { formatDuration } from "../format";
import { recoverIsrcViaDeezer, verifySearchCandidate } from "./anchor";
import { parseArtistsJson, stampRemixerRoles, upsertTrackArtists } from "./artists";
import { postToBluesky } from "./bluesky";
import { getDb, typedRow } from "./db";
import { type DeezerIsrcCandidate, enrichFromDeezer, lookupIsrcFromDeezer } from "./deezer";
import { discogsResolveRelease } from "./discogs";
import { batchDueWorkSourceMutation, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID } from "./due-work";
import { purgeLogCache } from "./edge-cache";
import {
  type HubCountDelta,
  hubCountDeltaForTrackArtistsStatement,
  hubCountDeltaStatement,
} from "./hub-counts";
import { submitFindingToIndexNow } from "./indexnow";
import { hasIsrc } from "./isrc";
import { linkTrackToAlbum, storeAlbumDiscogsFactsForTrack } from "./albums";
import { linkTrackToLabel } from "./labels";
import { lastfmLove } from "./lastfm";
import { logEvent } from "./log";
import { resolveLogId } from "./log-id";
import { notifyNewFinding } from "./push";
import { formatError, withRetries } from "./retry";
import {
  addTrackToPlaylist,
  ApiError,
  fetchTrackMetadata,
  findSpotifyTrackByIsrc,
  parseSpotifyTrackUrl,
  SPOTIFY_REAUTH_REQUIRED,
  type TrackMetadata,
} from "./spotify";
import { formatTelegramMessage, postToTelegram } from "./telegram";
import { insertTrackDuplicateKeyStatement } from "./track-duplicate-keys";
import { purgeTrackEntityPages } from "./entity-cache-purge";

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

function dryRunPublishResult(
  track: TrackMetadata,
  artistLine: string,
  logId: string,
  note: string | undefined,
): PublishTrackResult {
  const message = `Dry run

${artistLine}
Log ID: fluncle://${logId}
Album: ${track.album ?? "Unknown"}
Duration: ${formatDuration(track.durationMs)}
Spotify: ${track.spotifyUrl}

Telegram message:

${formatTelegramMessage(track, note, logId)}

No database, Spotify, or Telegram changes were made. Enrichment (label, preview) runs on publish.`;

  return buildAddResult(
    track,
    message,
    { addedToSpotify: false, dryRun: true, postedToTelegram: false },
    { logId },
  );
}

function verifiedDeezerLink(
  track: TrackMetadata,
  byName: DeezerIsrcCandidate | undefined,
  byIsrcTrackId: string | undefined,
) {
  const verified = byName
    ? verifySearchCandidate(track.artists, track.title, track.durationMs, [
        {
          artists: [byName.artistName],
          deezerTrackId: byName.deezerTrackId,
          durationMs: byName.durationMs,
          title: byName.title,
        },
      ])
    : undefined;
  return deezerLinkFor(verified?.candidate.deezerTrackId, verified?.via, byIsrcTrackId);
}

function isPublishedFlag(value: number | null): boolean {
  return Number(value ?? 0) === 1;
}

const CERTIFY_DELTA: HubCountDelta = { certified: 1, renderable: 0 };

async function resolveFindingLogId(
  db: Awaited<ReturnType<typeof getDb>>,
  input: { foundAt: string; isrc?: null | string; trackId: string },
): Promise<string> {
  return resolveLogId(
    { foundAt: input.foundAt, isrc: input.isrc, trackId: input.trackId },
    async (candidate) => {
      const taken = await db.execute({
        args: [candidate],
        sql: `select 1 from findings where log_id = ? limit 1`,
      });

      return taken.rows.length > 0;
    },
  );
}

function findingInsertStatement(input: {
  logId: string;
  note?: null | string;
  nowIso: string;
  trackId: string;
}): InStatement {
  return {
    args: [input.trackId, input.logId, input.note ?? null, input.nowIso, input.nowIso, 0, 0],
    sql: `insert into findings (
        track_id,
        log_id,
        note,
        added_at,
        updated_at,
        added_to_spotify,
        posted_to_telegram
      ) values (?, ?, ?, ?, ?, ?, ?)`,
  };
}

function throwForExistingPublishedTrack(existing: TrackRow | undefined): void {
  if (!existing) {
    return;
  }
  const existingLine = `${parseArtistsJson(existing.artists_json).join(", ")} — ${existing.title}`;
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

function deezerLinkFor(
  searchTrackId: string | undefined,
  searchVia: "search" | "search-subset" | undefined,
  isrcTrackId: string | undefined,
): { trackId: string; via: "isrc" | "search" | "search-subset" } | undefined {
  if (searchTrackId && searchVia) {
    return { trackId: searchTrackId, via: searchVia };
  }
  return isrcTrackId ? { trackId: isrcTrackId, via: "isrc" } : undefined;
}

function hasDiscogsReference(releaseId: number | undefined, masterId: number | undefined): boolean {
  return releaseId !== undefined || masterId !== undefined;
}

async function announcePublishedTrack(
  db: Awaited<ReturnType<typeof getDb>>,
  track: Awaited<ReturnType<typeof fetchTrackMetadata>>,
  note: string | undefined,
  logId: string,
): Promise<void> {
  try {
    await withRetries("Spotify playlist add", () => addTrackToPlaylist(track));
  } catch (error) {
    const message = formatError(error);
    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [message, new Date().toISOString(), track.trackId],
          sql: `update findings set spotify_error = ?, updated_at = ? where track_id = ?`,
        },
      ],
      [{ subjectId: track.trackId, subjectType: "track" }],
      { producer: "publish-spotify-error" },
    );

    if (error instanceof ApiError && error.code === SPOTIFY_REAUTH_REQUIRED) {
      throw error;
    }

    throw new ApiError("spotify_failed", `Spotify failed. Telegram was not posted.\n${message}`);
  }

  try {
    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [new Date().toISOString(), new Date().toISOString(), track.trackId],
          sql: `update findings
            set added_to_spotify = 1,
              added_to_spotify_at = ?,
              spotify_error = null,
              updated_at = ?
            where track_id = ?`,
        },
      ],
      [{ subjectId: track.trackId, subjectType: "track" }],
      { producer: "publish-spotify-success" },
    );
  } catch (error) {
    throw new ApiError(
      "db_update_failed",
      `Spotify succeeded, but the database update failed. Telegram was not posted.\n${formatError(error)}`,
    );
  }

  try {
    await withRetries("Telegram post", () => postToTelegram(track, note, logId));
  } catch (error) {
    const message = formatError(error);
    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [message, new Date().toISOString(), track.trackId],
          sql: `update findings set telegram_error = ?, updated_at = ? where track_id = ?`,
        },
      ],
      [{ subjectId: track.trackId, subjectType: "track" }],
      { producer: "publish-telegram-error" },
    );

    throw new ApiError("telegram_failed", `Spotify succeeded, but Telegram failed.\n${message}`);
  }

  try {
    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [new Date().toISOString(), new Date().toISOString(), track.trackId],
          sql: `update findings
            set posted_to_telegram = 1,
              posted_to_telegram_at = ?,
              telegram_error = null,
              updated_at = ?
            where track_id = ?`,
        },
      ],
      [{ subjectId: track.trackId, subjectType: "track" }],
      { producer: "publish-telegram-success" },
    );
  } catch (error) {
    throw new ApiError(
      "db_update_failed",
      `Telegram posted, but the database update failed.\n${formatError(error)}`,
    );
  }
}

export async function publishTrack(
  spotifyUrl: string,
  options: AddOptions,
): Promise<PublishTrackResult> {
  const db = await getDb();
  const trackId = parseSpotifyTrackUrl(spotifyUrl);
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select tracks.track_id, tracks.title, tracks.artists_json,
             findings.added_to_spotify, findings.posted_to_telegram
      from findings join tracks on tracks.track_id = findings.track_id
      where findings.track_id = ?
      limit 1`,
  });
  const existing = typedRow<TrackRow>(existingResult.rows);

  throwForExistingPublishedTrack(existing);

  const track = await fetchTrackMetadata(trackId);
  const artistLine = `${track.artists.join(", ")} — ${track.title}`;
  const nowIso = new Date().toISOString();

  const deezerByName = track.isrc?.trim() ? undefined : await lookupIsrcFromDeezer(track);

  if (deezerByName) {
    track.isrc = deezerByName.isrc;
  }

  const logId = await resolveFindingLogId(db, {
    foundAt: nowIso,
    isrc: track.isrc,
    trackId: track.trackId,
  });

  if (options.dryRun) {
    return dryRunPublishResult(track, artistLine, logId, options.note);
  }

  const deezer = await enrichFromDeezer(track.isrc, track.durationMs);

  const deezerLink = verifiedDeezerLink(track, deezerByName, deezer.deezerTrackId);

  const discogs = await discogsResolveRelease({
    album: track.album,
    artists: track.artists,
    isrc: track.isrc,
    label: deezer.label,
    releaseDate: track.releaseDate,
    title: track.title,
  });

  const discogsResolved = hasDiscogsReference(discogs.releaseId, discogs.masterId);
  const discogsAttemptedAt = discogsResolved || !discogs.rateLimited ? nowIso : null;
  const artistsJson = JSON.stringify(track.artists);

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [
          track.trackId,
          track.spotifyUrl,
          track.spotifyUri,
          track.title,
          artistsJson,
          track.album ?? null,
          track.albumImageUrl ?? null,
          track.releaseDate ?? null,
          track.durationMs,
          track.isrc ?? null,
          hasIsrc(track.isrc),
          deezer.label ?? null,
          track.popularity ?? null,
          deezer.previewUrl ?? null,
          discogs.releaseId ?? null,
          discogs.masterId ?? null,
          nowIso,
          discogsAttemptedAt,
          discogsResolved ? nowIso : null,
          discogsAttemptedAt === null ? 0 : 1,
          nowIso,
          deezerLink?.trackId ?? null,
          deezerLink ? nowIso : null,
          deezerLink?.via ?? null,
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
            has_isrc,
            label,
            popularity,
            preview_url,
            in_release_id,
            in_master_id,
            isrc_attempted_at,
            backfill_discogs_attempted_at,
            backfill_discogs_done_at,
            backfill_discogs_attempts,
            spotify_anchored_at,
            spotify_anchor_source,
            spotify_anchor_verified_by,
            deezer_track_id,
            deezer_verified_at,
            deezer_verified_by,
            is_catalogue
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'publish', 'publish', ?, ?, ?, ?)`,
      },
      insertTrackDuplicateKeyStatement({
        artistsJson,
        isrc: track.isrc ?? null,
        title: track.title,
        trackId: track.trackId,
      }),
      findingInsertStatement({ logId, note: options.note, nowIso, trackId: track.trackId }),
    ],
    [
      { subjectId: track.trackId, subjectType: "track" },
      { subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID, subjectType: "track" },
    ],
    { producer: "publish-track" },
  );

  try {
    await upsertTrackArtists(track.trackId, track.artists, track.spotifyArtistIds);
    await stampRemixerRoles([track.trackId]);
  } catch (artistError) {
    logEvent("warn", "publish.artist-upsert-failed", {
      error: artistError,
      logId,
      trackId: track.trackId,
    });
  }

  try {
    await Promise.all([
      linkTrackToLabel(track.trackId, deezer.label),
      linkTrackToAlbum(track.trackId, track.album),
    ]);

    if (discogs.catno !== undefined || discogs.styles !== undefined) {
      await storeAlbumDiscogsFactsForTrack(track.trackId, {
        catno: discogs.catno,
        styles: discogs.styles,
      });
    }
  } catch (labelError) {
    logEvent("warn", "publish.graph-entity-upsert-failed", {
      error: labelError,
      logId,
      trackId: track.trackId,
    });
  }

  await announcePublishedTrack(db, track, options.note, logId);

  purgeLogCache(logId);
  purgeTrackEntityPages(track.trackId);
  await lastfmLove(track.artists[0] ?? track.artists.join(", "), track.title);
  notifyNewFinding(track, logId);
  try {
    await postToBluesky(track, options.note, logId);
  } catch (blueskyError) {
    logEvent("warn", "publish.bluesky-post-failed", {
      error: blueskyError,
      logId,
      trackId: track.trackId,
    });
  }
  submitFindingToIndexNow(logId, track.trackId);

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

async function certifyExistingTrackWithOptions(
  trackId: string,
  options: { note?: string },
): Promise<{ logId: string }> {
  const db = await getDb();
  const row = typedRow<{
    added_to_spotify: number | null;
    album: null | string;
    album_id: null | string;
    album_image_url: null | string;
    artists_json: string;
    duration_ms: number;
    finding_id: null | string;
    finding_log_id: null | string;
    finding_note: null | string;
    isrc: null | string;
    label: null | string;
    label_id: null | string;
    posted_to_telegram: number | null;
    spotify_uri: null | string;
    spotify_url: null | string;
    title: string;
    track_id: string;
  }>(
    (
      await db.execute({
        args: [trackId],
        sql: `select tracks.track_id, tracks.title, tracks.artists_json, tracks.isrc,
                     tracks.label, tracks.album, tracks.album_image_url, tracks.duration_ms,
                     tracks.spotify_uri, tracks.spotify_url,
                     tracks.label_id, tracks.album_id,
                     findings.track_id as finding_id, findings.log_id as finding_log_id,
                     findings.note as finding_note,
                     findings.added_to_spotify as added_to_spotify,
                     findings.posted_to_telegram as posted_to_telegram
              from tracks
              left join findings on findings.track_id = tracks.track_id
              where tracks.track_id = ?
              limit 1`,
      })
    ).rows,
  );

  if (!row) {
    throw new ApiError("not_found", `No track with id ${trackId}.`, 404);
  }

  const artists = parseArtistsJson(row.artists_json);
  const line = `${artists.join(", ")} — ${row.title}`;
  const alreadySpotify = isPublishedFlag(row.added_to_spotify);
  const alreadyTelegram = isPublishedFlag(row.posted_to_telegram);

  if (row.finding_id && alreadySpotify && alreadyTelegram) {
    throw new ApiError("already_certified", `Already logged: ${line}`, 409);
  }

  const isrc =
    row.isrc ??
    (await recoverIsrcViaDeezer(trackId, db, artists, row.title, row.duration_ms)) ??
    null;

  let spotifyUri = row.spotify_uri;
  let spotifyUrl = row.spotify_url;

  if (!spotifyUri && isrc) {
    const lookup = await findSpotifyTrackByIsrc(isrc);

    if (lookup.match) {
      spotifyUri = lookup.match.spotifyUri;
      spotifyUrl = lookup.match.spotifyUrl;
      await batchDueWorkSourceMutation(
        db,
        [
          {
            args: [spotifyUri, spotifyUrl, new Date().toISOString(), trackId],
            sql: `update tracks
              set spotify_uri = ?,
                  spotify_url = ?,
                  spotify_anchor_source = 'spotify-isrc',
                  spotify_anchor_verified_by = 'isrc',
                  spotify_anchored_at = ?
              where track_id = ?`,
          },
        ],
        [{ subjectId: trackId, subjectType: "track" }],
        { producer: "certify-track-anchor" },
      );
    }
  }

  if (!spotifyUri || !spotifyUrl) {
    throw new ApiError(
      "no_spotify_anchor",
      `Cannot certify ${line}: no Spotify identity, and no ISRC match to resolve one. Only a Spotify-linked banger can be certified.`,
      409,
    );
  }

  const nowIso = new Date().toISOString();
  let logId: string;

  if (row.finding_id && row.finding_log_id) {
    logId = row.finding_log_id;
  } else {
    logId = await resolveFindingLogId(db, { foundAt: nowIso, isrc, trackId });
    await batchDueWorkSourceMutation(
      db,
      [
        findingInsertStatement({ logId, note: options.note, nowIso, trackId }),
        { args: [trackId], sql: `update tracks set is_catalogue = 0 where track_id = ?` },
        ...(row.label_id ? [hubCountDeltaStatement("labels", row.label_id, CERTIFY_DELTA)] : []),
        ...(row.album_id ? [hubCountDeltaStatement("albums", row.album_id, CERTIFY_DELTA)] : []),
        hubCountDeltaForTrackArtistsStatement(trackId, CERTIFY_DELTA),
      ],
      [
        { subjectId: trackId, subjectType: "track" },
        { subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID, subjectType: "track" },
      ],
      { producer: "certify-track" },
    );

    try {
      await Promise.all([
        linkTrackToLabel(trackId, row.label),
        linkTrackToAlbum(trackId, row.album),
      ]);
    } catch (labelError) {
      logEvent("warn", "certify.graph-entity-upsert-failed", { error: labelError, logId, trackId });
    }

    purgeLogCache(logId);
    purgeTrackEntityPages(trackId);
    submitFindingToIndexNow(logId, trackId);
  }

  const note = options.note ?? row.finding_note ?? undefined;

  const metadata: TrackMetadata = {
    album: row.album ?? undefined,
    albumImageUrl: row.album_image_url ?? undefined,
    artists,
    durationMs: row.duration_ms,
    isrc: isrc ?? undefined,
    spotifyArtistIds: [],
    spotifyUri,
    spotifyUrl,
    title: row.title,
    trackId,
  };

  if (!alreadySpotify) {
    if (spotifyUri) {
      try {
        await withRetries("Spotify playlist add", () => addTrackToPlaylist(metadata));
        await batchDueWorkSourceMutation(
          db,
          [
            {
              args: [nowIso, nowIso, trackId],
              sql: `update findings
                    set added_to_spotify = 1, added_to_spotify_at = ?, spotify_error = null,
                        updated_at = ?
                    where track_id = ?`,
            },
          ],
          [{ subjectId: trackId, subjectType: "track" }],
          { producer: "certify-spotify-success" },
        );
      } catch (error) {
        await batchDueWorkSourceMutation(
          db,
          [
            {
              args: [formatError(error), nowIso, trackId],
              sql: `update findings set spotify_error = ?, updated_at = ? where track_id = ?`,
            },
          ],
          [{ subjectId: trackId, subjectType: "track" }],
          { producer: "certify-spotify-error" },
        );
      }
    } else {
      await batchDueWorkSourceMutation(
        db,
        [
          {
            args: [nowIso, trackId],
            sql: `update findings
                  set spotify_error = 'no Spotify presence (no exact-ISRC match) — link manually',
                      updated_at = ?
                  where track_id = ?`,
          },
        ],
        [{ subjectId: trackId, subjectType: "track" }],
        { producer: "certify-spotify-missing" },
      );
    }
  }

  if (!alreadyTelegram) {
    try {
      await withRetries("Telegram post", () => postToTelegram(metadata, note, logId));
      await batchDueWorkSourceMutation(
        db,
        [
          {
            args: [nowIso, nowIso, trackId],
            sql: `update findings
                  set posted_to_telegram = 1, posted_to_telegram_at = ?, telegram_error = null,
                      updated_at = ?
                  where track_id = ?`,
          },
        ],
        [{ subjectId: trackId, subjectType: "track" }],
        { producer: "certify-telegram-success" },
      );
    } catch (error) {
      await batchDueWorkSourceMutation(
        db,
        [
          {
            args: [formatError(error), nowIso, trackId],
            sql: `update findings set telegram_error = ?, updated_at = ? where track_id = ?`,
          },
        ],
        [{ subjectId: trackId, subjectType: "track" }],
        { producer: "certify-telegram-error" },
      );
    }

    await lastfmLove(artists[0] ?? artists.join(", "), row.title);
    notifyNewFinding(metadata, logId);

    if (spotifyUrl) {
      try {
        await postToBluesky(metadata, note, logId);
      } catch (blueskyError) {
        logEvent("warn", "certify.bluesky-post-failed", { error: blueskyError, logId, trackId });
      }
    }
  }

  return { logId };
}

export function certifyExistingTrack(
  trackId: string,
  options: { note?: string } = {},
): Promise<{ logId: string }> {
  return certifyExistingTrackWithOptions(trackId, options);
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
