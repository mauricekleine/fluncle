import { type InStatement } from "@libsql/client/web";
import { type PublishTrackResult } from "@fluncle/contracts";

export type { PublishTrackResult };

import { logPageUrl } from "../fluncle-links";
import { formatDuration } from "../format";
import { parseArtistsJson, upsertTrackArtists } from "./artists";
import { postToBluesky } from "./bluesky";
import { getDb, typedRow } from "./db";
import { enrichFromDeezer, lookupIsrcFromDeezer } from "./deezer";
import { discogsResolveRelease } from "./discogs";
import { purgeLogCache } from "./edge-cache";
import { submitFindingToIndexNow } from "./indexnow";
import { linkTrackToAlbum } from "./albums";
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

/**
 * THE CERTIFICATION MINT, single-sourced. Resolve a unique Log ID for a track from the found
 * date + the recording's ISRC (the Spotify id as fallback), retrying to a fresh tail on the rare
 * collision. Shared by the Spotify add path (`publishTrack`) and the certify-in-place path
 * (`certifyExistingTrack`), so a coordinate is minted the SAME way however a finding is born.
 */
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

/**
 * THE CERTIFICATION-HALF INSERT, single-sourced (docs/track-lifecycle.md). The one statement that
 * turns a `tracks` row into a finding: its coordinate, its note, its found date, and the publish
 * bookkeeping. `enrichment_status` takes its DDL default (`pending`), which is what enqueues the
 * fresh finding for the enrich sweep. Reused verbatim by `publishTrack` (inside its atomic
 * tracks+findings batch) and `certifyExistingTrack` (the row already exists, so this alone mints).
 */
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
  const logId = await resolveFindingLogId(db, {
    foundAt: nowIso,
    isrc: track.isrc,
    trackId: track.trackId,
  });

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
  // video) are filled later by the async enrichment agent; the finding's galaxy is
  // assigned later still by the nightly `fluncle-cluster` sweep, k-means over the MuQ
  // embedding (the manual tagging tool that once placed it by hand is retired).
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

  await db.batch(
    [
      {
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
          track.popularity ?? null,
          deezer.previewUrl ?? null,
          discogs.releaseId ?? null,
          discogs.masterId ?? null,
        ],
        // The RECORDING half — everything true of the track itself.
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
            popularity,
            preview_url,
            in_release_id,
            in_master_id
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      },
      // The CERTIFICATION half — the coordinate, the note, the found date, the publish state,
      // minted through the shared `findingInsertStatement` so certify-in-place cannot drift.
      findingInsertStatement({ logId, note: options.note, nowIso, trackId: track.trackId }),
    ],
    "write",
  );

  // Best-effort: populate the artist entity tables (artists + track_artists) so
  // the identity graph is ready for the resolution sweep. Uses the artist IDs
  // Spotify returns on the track response (no extra API call). A failure here
  // must never block the publish — same discipline as the Deezer / Last.fm side
  // channels; the backfill covers any rows a failed call leaves behind.
  try {
    await upsertTrackArtists(track.trackId, track.artists, track.spotifyArtistIds);
  } catch (artistError) {
    logEvent("warn", "publish.artist-upsert-failed", {
      error: artistError,
      logId,
      trackId: track.trackId,
    });
  }

  // Best-effort: mint the graph entities this track hangs off — its LABEL (the one Deezer
  // just handed back) and its ALBUM — and stamp the track's `label_id` / `album_id` pointers
  // at them, which is the indexed edge the public /label/<slug> + /album/<slug> pages read
  // by. A brand-new label enters `undecided` — never silently crawled, never silently
  // dropped — and lands in the operator's attention queue as a label to rule on; an album
  // carries no ruling at all (docs/album-entity.md).
  //
  // Purely additive: two entity rows and two pointers, nothing else touched — so a failure
  // never blocks the publish (the deploy-time reconciles in scripts/backfill-labels.ts +
  // scripts/backfill-albums.ts back both of them up).
  try {
    await Promise.all([
      linkTrackToLabel(track.trackId, deezer.label),
      linkTrackToAlbum(track.trackId, track.album),
    ]);
  } catch (labelError) {
    logEvent("warn", "publish.graph-entity-upsert-failed", {
      error: labelError,
      logId,
      trackId: track.trackId,
    });
  }

  try {
    await withRetries("Spotify playlist add", () => addTrackToPlaylist(track));
  } catch (error) {
    const message = formatError(error);
    await db.execute({
      args: [message, new Date().toISOString(), track.trackId],
      sql: `update findings set spotify_error = ?, updated_at = ? where track_id = ?`,
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
      sql: `update findings
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
      sql: `update findings set telegram_error = ?, updated_at = ? where track_id = ?`,
    });

    throw new ApiError("telegram_failed", `Spotify succeeded, but Telegram failed.\n${message}`);
  }

  try {
    await db.execute({
      args: [new Date().toISOString(), new Date().toISOString(), track.trackId],
      sql: `update findings
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
  // Best-effort: post the finding to Bluesky as a link card (bluesky.ts). Gated on
  // BLUESKY_IDENTIFIER + BLUESKY_APP_PASSWORD — a NO-OP until configured. Awaited
  // but wrapped: a Bluesky failure is logged and swallowed, so it can NEVER fail or
  // delay the publish — nor the Telegram leg, which already ran above. Same
  // side-channel discipline as the artist upsert / Last.fm love.
  try {
    await postToBluesky(track, options.note, logId);
  } catch (blueskyError) {
    logEvent("warn", "publish.bluesky-post-failed", {
      error: blueskyError,
      logId,
      trackId: track.trackId,
    });
  }
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

/**
 * CERTIFY IN PLACE (docs/the-ear.md § The operator's actions) — turn an EXISTING catalogue row
 * into a finding, WITHOUT creating a new track. This is the "Log it" the Ear's workstation fires:
 * a catalogue track (a `tracks` row with no `findings` row) is the same recording Fluncle already
 * knows — the Spotify add path would re-fetch it and try to insert a duplicate `tracks` row, so
 * certification here mints ONLY the certification half.
 *
 * It shares the exact mint the Spotify add uses (`resolveFindingLogId` + `findingInsertStatement`),
 * so a coordinate is born the same way however a finding arrives — AND the same announce fan-out
 * (operator ruling, 2026-07-13: the first workstation certify skipped Spotify + Telegram, and a
 * finding is a finding however it arrives). The differences from `publishTrack`, both deliberate:
 *
 *   · PRESENCE IS RESOLVED, NEVER ASSUMED. A crawled row may have no Spotify identity at all, so
 *     the playlist add rides the row's stored `spotify_uri` or an exact-ISRC lookup
 *     (`findSpotifyTrackByIsrc` — the honest resolver: a hit is stamped back onto the track, a
 *     miss is recorded, and a fuzzy metadata guess NEVER reaches the public playlist). The legs
 *     that print the Spotify link degrade with it: Telegram simply omits the line
 *     (`formatTelegramMessage`), Bluesky — whose card is built around the link — is skipped.
 *   · A LEG FAILURE NEVER UNWINDS THE MINT. `publishTrack` throws mid-chain because its caller is
 *     the CLI mid-add; here the finding already exists and the operator has moved on, so each leg
 *     records its failure on the findings error columns (`spotify_error` / `telegram_error` — the
 *     attention queue's existing rails) and the mint stands.
 *   · IT RESUMES. Re-certifying an already-logged row is a 409 only when BOTH announce legs are
 *     done; with legs missing it runs exactly the missing ones (fill-empty semantics — a posted
 *     leg is never re-posted). That makes `certify` its own retry: a leg that failed (or a finding
 *     certified before this fan-out existed) is finished by firing certify again.
 *
 * `enrichment_status` takes its DDL default (`pending`), which enqueues the fresh finding for the
 * enrichment chain, so the operator lands on the finding's admin surface with the pipeline moving.
 * Guards: the row must EXIST (404). Graph links + cache purge + IndexNow stay best-effort.
 */
export async function certifyExistingTrack(
  trackId: string,
  options: { note?: string } = {},
): Promise<{ logId: string }> {
  const db = await getDb();
  const row = typedRow<{
    added_to_spotify: number | null;
    album: null | string;
    album_image_url: null | string;
    artists_json: string;
    duration_ms: number;
    finding_id: null | string;
    finding_log_id: null | string;
    finding_note: null | string;
    isrc: null | string;
    label: null | string;
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
  const alreadySpotify = Number(row.added_to_spotify ?? 0) === 1;
  const alreadyTelegram = Number(row.posted_to_telegram ?? 0) === 1;

  if (row.finding_id && alreadySpotify && alreadyTelegram) {
    throw new ApiError("already_certified", `Already logged: ${line}`, 409);
  }

  const nowIso = new Date().toISOString();
  let logId: string;

  if (row.finding_id && row.finding_log_id) {
    // THE RESUME: the finding exists with announce legs missing — a leg that failed, or a
    // certify from before the fan-out. Run only what is missing; mint nothing.
    logId = row.finding_log_id;
  } else {
    logId = await resolveFindingLogId(db, { foundAt: nowIso, isrc: row.isrc, trackId });
    await db.execute(findingInsertStatement({ logId, note: options.note, nowIso, trackId }));

    // Best-effort, exactly as the Spotify add does it: mint the graph entities this track now
    // hangs off (its label + album, both minted ONLY off a certified finding) and stamp its
    // pointers. Purely additive; the deploy-time reconciles back both up, so a miss never blocks.
    try {
      await Promise.all([
        linkTrackToLabel(trackId, row.label),
        linkTrackToAlbum(trackId, row.album),
      ]);
    } catch (labelError) {
      logEvent("warn", "certify.graph-entity-upsert-failed", { error: labelError, logId, trackId });
    }

    // A new finding now sits at the top of `/log` and owns its coordinate page: drop the edge
    // cache and ping IndexNow so both re-render / re-crawl. Both are fire-and-forget-safe.
    purgeLogCache(logId);
    submitFindingToIndexNow(logId);
  }

  const note = options.note ?? row.finding_note ?? undefined;

  // ── THE ANNOUNCE FAN-OUT (record-not-throw; each leg fills only its own empty slot) ────────
  // Presence first: the stored identity, else one exact-ISRC lookup. A hit is stamped back onto
  // the track (the same columns the crawler's own anchor uses), so the resolve is paid once.
  let spotifyUri = row.spotify_uri;
  let spotifyUrl = row.spotify_url;

  if (!spotifyUri && row.isrc && !(alreadySpotify && alreadyTelegram)) {
    const lookup = await findSpotifyTrackByIsrc(row.isrc);

    if (lookup.match) {
      spotifyUri = lookup.match.spotifyUri;
      spotifyUrl = lookup.match.spotifyUrl;
      await db.execute({
        args: [spotifyUri, spotifyUrl, trackId],
        sql: `update tracks set spotify_uri = ?, spotify_url = ? where track_id = ?`,
      });
    }
  }

  const metadata: TrackMetadata = {
    album: row.album ?? undefined,
    albumImageUrl: row.album_image_url ?? undefined,
    artists,
    durationMs: row.duration_ms,
    isrc: row.isrc ?? undefined,
    spotifyArtistIds: [],
    spotifyUri: spotifyUri ?? "",
    spotifyUrl: spotifyUrl ?? "",
    title: row.title,
    trackId,
  };

  if (!alreadySpotify) {
    if (spotifyUri) {
      try {
        await withRetries("Spotify playlist add", () => addTrackToPlaylist(metadata));
        await db.execute({
          args: [nowIso, nowIso, trackId],
          sql: `update findings
                set added_to_spotify = 1, added_to_spotify_at = ?, spotify_error = null,
                    updated_at = ?
                where track_id = ?`,
        });
      } catch (error) {
        await db.execute({
          args: [formatError(error), nowIso, trackId],
          sql: `update findings set spotify_error = ?, updated_at = ? where track_id = ?`,
        });
      }
    } else {
      // The honest miss: no stored identity and no exact-ISRC match. Recorded on the same
      // attention rail as a failed add — the operator links it by hand (or re-certifies once an
      // ISRC lands) — because a fuzzy metadata guess must never reach the public playlist.
      await db.execute({
        args: [nowIso, trackId],
        sql: `update findings
              set spotify_error = 'no Spotify presence (no exact-ISRC match) — link manually',
                  updated_at = ?
              where track_id = ?`,
      });
    }
  }

  if (!alreadyTelegram) {
    try {
      await withRetries("Telegram post", () => postToTelegram(metadata, note, logId));
      await db.execute({
        args: [nowIso, nowIso, trackId],
        sql: `update findings
              set posted_to_telegram = 1, posted_to_telegram_at = ?, telegram_error = null,
                  updated_at = ?
              where track_id = ?`,
      });
    } catch (error) {
      await db.execute({
        args: [formatError(error), nowIso, trackId],
        sql: `update findings set telegram_error = ?, updated_at = ? where track_id = ?`,
      });
    }

    // The best-effort announce wave rides the FIRST Telegram attempt (posted was 0 at entry), so
    // a later Spotify-only resume never re-loves / re-pushes / re-posts what already went out.
    await lastfmLove(artists[0] ?? artists.join(", "), row.title);
    notifyNewFinding(metadata, logId);

    if (spotifyUrl) {
      // Bluesky's link card is built around the Spotify link — a no-presence finding skips it.
      try {
        await postToBluesky(metadata, note, logId);
      } catch (blueskyError) {
        logEvent("warn", "certify.bluesky-post-failed", { error: blueskyError, logId, trackId });
      }
    }
  }

  return { logId };
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
