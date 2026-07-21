// THE SPOTIFY ANCHOR — the verify+write boundary for a catalogue row's Spotify identity.
//
// A catalogue track (a `tracks` row with no `findings` row) is resolved from MusicBrainz, so
// it may land with no Spotify presence at all — hence the nullable `spotify_uri`/`spotify_url`.
// The ANCHOR is the step that fills them: given candidate Spotify tracks for a row, it VERIFIES
// one is genuinely the same recording and stamps the row. A wrong anchor poisons the private
// telescope playlist and the certify path, so this module's whole job is precision over recall:
// a miss is fine, a wrong stamp is not.
//
// ── WHERE THE CANDIDATES COME FROM: THE RESOLVER WATERFALL ───────────────────────────────────
// The candidates used to come from the Worker calling Spotify's own `search`/`tracks` endpoints
// inside the crawl tick (`fillSpotifyAnchors`). That app is a dev-mode Spotify app on a tiny
// permanent budget, and at catalogue scale it starved under sustained 429s. So ALL catalogue
// anchor-filling moved OFF the official Spotify app onto a box sweep
// (docs/agents/hermes/scripts/anchor-sweep.*). That sweep now runs a TWO-RUNG waterfall per row:
//   1. THE FREE RUNG (`resolveAnchorFree`, below). ListenBrainz labs maps the row's MusicBrainz
//      recording MBID → Spotify track ids for free, with no auth (lib/server/listenbrainz.ts). The
//      first id's metadata is fetched with ONE `GET /v1/tracks/{id}` (a cheap by-id read, never a
//      search) to get its ISRC + duration, and that candidate is run through the SAME gate below.
//   2. THE APIFY FALLBACK (`anchorTrack`). Only when the free rung MISSES does the box spend the
//      metered Apify search actor, map its results to candidates, and POST them to `anchor_track`.
// So Apify became the fallback, not the sole source: a hit on the free rung spends nothing, and an
// Apify outage still leaves the free rung anchoring its share (graceful degradation). The official
// Spotify app serves ONLY user-facing paths (adds, publish, the Frontier playlist mints) plus the
// free rung's one by-id metadata read per hit — never a catalogue search.
//
// NO SOURCE'S VERDICT IS EVER TRUSTED. Neither the box's Apify match NOR ListenBrainz's mapping is
// believed: the SERVER re-runs the full verification below against BOTH, exactly as it did when it
// held the Spotify call — so a re-baked box script (or a wrong ListenBrainz map) can never invent a
// looser match rule. This is the `verify_capture` doctrine: the sources fetch, the Worker rules.
//
// ── TWO RUNGS, precision over recall ─────────────────────────────────────────────────────────
//   1. ISRC EQUALITY — the exact rung. The Apify actor returns each candidate's `track_isrc`, so
//      a row that carries an ISRC anchors to the candidate whose ISRC matches it (case-insensitive).
//      If several candidates share the ISRC — a re-press under a different Spotify track id, seen
//      live — the closest duration wins. An ISRC match is the recording's real identity: trustworthy.
//   2. THE VERIFIED SEARCH TRIPLE — the recall unlock, and the fallback for a no-ISRC row (or a row
//      whose ISRC matched nothing). A candidate anchors ONLY when it clears ALL THREE signals: the
//      same artist SET, the same base title, and the same version descriptor (all three carried by
//      the ratified `matchKey` fold — so the original of a logged VIP can never anchor to the VIP),
//      AND a duration within ±2s of the row's. Of the candidates that clear it, the closest duration
//      wins. This is the SAME gate the in-Worker fill used, moved here verbatim.
//
// EVERY ATTEMPTED ROW is stamped `spotify_anchor_attempted_at` — a hit AND a miss — so the anchor
// worklist can back a missed row off (track-work.ts `ANCHOR_REASK_AFTER_DAYS`) instead of re-asking
// it every tick (each re-ask is a billed Apify search). See docs/catalogue-crawler.md § the anchor.

import { parseArtistsJson, stampRemixerRoles, upsertTrackArtists } from "./artists";
import { getDb, typedRows } from "./db";
import { lookupSpotifyIdsByMbid } from "./listenbrainz";
import { logEvent } from "./log";
import { fetchTrackMetadata } from "./spotify";
import { matchKey } from "./track-match";

/** ±window on the row↔candidate duration match — one of the search rung's three verification signals. */
export const ANCHOR_DURATION_TOLERANCE_MS = 2000;

/** The free-text query the search rung asks of Spotify — the row's artists, then its title. */
export function anchorSearchQuery(artists: string[], title: string): string {
  return [...artists, title].join(" ").trim();
}

/** One credited artist on a candidate — its name, and its stable Spotify id when the actor carried one. */
export type AnchorArtist = { id?: null | string; name: string };

/**
 * One Spotify candidate for a catalogue row, mapped from the Apify actor's output. `spotifyTrackId`
 * is the resolved bare id (the handler derives it from the actor's `track_id` / `track_uri` /
 * `track_url`); the anchor is written as `spotify:track:<id>` + `https://open.spotify.com/track/<id>`.
 */
export type AnchorCandidate = {
  albumImageUrl?: null | string;
  artists: AnchorArtist[];
  durationMs?: null | number;
  isrc?: null | string;
  spotifyTrackId: string;
  title: string;
};

/** Which rung verified an anchor, or `null` on a miss. */
export type AnchorVerification = "isrc" | "search" | null;

/** The minimal shape the verified-search gate reads off a candidate. */
type VerifiableCandidate = {
  artists: string[];
  durationMs?: null | number;
  title: string;
};

/**
 * THE VERIFIED-SEARCH GATE. A candidate anchors ONLY when it clears ALL THREE signals: the same
 * artist SET, the same base title, and the same version descriptor as the row (all three carried
 * by the ratified `matchKey` fold — which deliberately keeps a remix/VIP descriptor distinct, so
 * the original of a logged VIP can never anchor to the VIP), AND a duration within ±2s of the
 * row's. Of the candidates that clear it, the closest duration wins; if none clear it, `undefined`
 * and the row stays in rotation. A candidate with no duration cannot be verified, so it is dropped.
 */
export function pickVerifiedCandidate<T extends VerifiableCandidate>(
  rowArtists: string[],
  rowTitle: string,
  rowDurationMs: number,
  candidates: T[],
): T | undefined {
  const rowKey = matchKey(rowArtists, rowTitle);

  return candidates
    .filter(
      (candidate) =>
        typeof candidate.durationMs === "number" &&
        Math.abs(candidate.durationMs - rowDurationMs) <= ANCHOR_DURATION_TOLERANCE_MS &&
        matchKey(candidate.artists, candidate.title) === rowKey,
    )
    .sort(
      (left, right) =>
        Math.abs((left.durationMs ?? 0) - rowDurationMs) -
        Math.abs((right.durationMs ?? 0) - rowDurationMs),
    )[0];
}

/** The minimal shape the exact-ISRC rung reads off a candidate. */
type IsrcCandidate = {
  durationMs?: null | number;
  isrc?: null | string;
};

/**
 * THE EXACT-ISRC RUNG. Of the candidates whose ISRC equals the row's (case-insensitive, trimmed),
 * the closest duration wins — a recording pressed under several Spotify track ids shares one ISRC,
 * so duration is the tiebreak. `undefined` when no candidate carries the row's ISRC. An ISRC match
 * is the recording's real identity, so this is the trusted first answer before the fuzzy search rung.
 */
export function pickIsrcCandidate<T extends IsrcCandidate>(
  rowIsrc: string,
  rowDurationMs: number,
  candidates: T[],
): T | undefined {
  const want = rowIsrc.trim().toLowerCase();

  if (!want) {
    return undefined;
  }

  return candidates
    .filter((candidate) => (candidate.isrc ?? "").trim().toLowerCase() === want)
    .sort(
      (left, right) =>
        Math.abs((left.durationMs ?? 0) - rowDurationMs) -
        Math.abs((right.durationMs ?? 0) - rowDurationMs),
    )[0];
}

/**
 * Connect-or-create a just-anchored catalogue track's ARTISTS by their stable `spotify_artist_id`
 * — riding the SAME candidate the anchor was read from (no extra Spotify call). `upsertTrackArtists`
 * mints an `artists` row per id (folded on the unique `spotify_artist_id`) and stamps the indexed
 * `track_artists` edge, so an artist that once folded fragilely on its NAME now folds on its stable
 * id. It MINTS NO FINDING: every read that means "finding" inner-joins `findings … log_id is not
 * null`, so this link moves none of them. `fillImages: false` keeps avatar fetches off this path —
 * the batched `backfill-artist-images` sweep fills them.
 *
 * Best-effort: the anchor columns are already stamped, so a link failure here must never derail the
 * fill. A track with NO Spotify presence never reaches here — its artist edge comes from the
 * name-fold `linkTracksToArtistEntities` at crawl-write time, minting nothing.
 */
export async function connectAnchorArtists(
  trackId: string,
  artistNames: string[],
  spotifyArtistIds: string[],
): Promise<void> {
  if (artistNames.length === 0) {
    return;
  }

  try {
    await upsertTrackArtists(trackId, artistNames, spotifyArtistIds, { fillImages: false });
    // A newly-anchored crawled remix may have just minted the remixer's `artists` row by its stable
    // Spotify id — so stamp the remixer credit now the link exists (RFC label-lineage-remixer, U2).
    await stampRemixerRoles([trackId]);
  } catch (error) {
    logEvent("warn", "anchor.artist-link-failed", { error, trackId });
  }
}

/** The one anchorable-row read: identity + the two rails (already anchored / certified). */
type AnchorRow = {
  artists_json: string;
  certified: number;
  duration_ms: number;
  isrc: null | string;
  spotify_uri: null | string;
  title: string;
};

/** The catalogue row the anchor targets is missing, certified, or already anchored. */
export type AnchorTrackReason = "already_anchored" | "certified" | "not_found";

export class AnchorTrackError extends Error {
  reason: AnchorTrackReason;

  constructor(reason: AnchorTrackReason, message: string) {
    super(message);
    this.name = "AnchorTrackError";
    this.reason = reason;
  }
}

/**
 * VERIFY box-supplied candidates against a catalogue row and, on a hit, write its Spotify anchor.
 *
 * The rails, checked before any verification (each throws `AnchorTrackError` so the op maps them to
 * an honest HTTP status): the row must EXIST, must be UNCERTIFIED (a finding's Spotify id is its
 * identity, written at publish — an agent never re-anchors one), and must not ALREADY carry an
 * anchor (a race with a concurrent user add).
 *
 * Then the two rungs, in order — exact ISRC first when the row carries one, the verified search
 * triple otherwise (or when the ISRC matched nothing). A HIT stamps the anchor + coalesces the
 * cover image + links the candidate's artists by their stable id, and always stamps
 * `spotify_anchor_attempted_at`.
 *
 * `stampOnMiss` (default true) governs ONLY the miss path. The Apify sweep POSTs with it true: a
 * miss stamps the attempt so the worklist backs the row off (`ANCHOR_REASK_AFTER_DAYS`) instead of
 * re-billing a search every tick. The FREE ListenBrainz rung (`resolveAnchorFree`) passes it FALSE:
 * a free-rung miss must leave the row UNSTAMPED so the SAME tick's Apify fallback (and, if Apify is
 * down, the next tick) still gets its turn — the row is only truly "attempted" once the rung that
 * SPENDS money has run. So the stamp reflects a full attempt, never a free-rung near-miss.
 */
export async function anchorTrack(
  trackId: string,
  candidates: AnchorCandidate[],
  options: { stampOnMiss?: boolean } = {},
): Promise<{ anchored: boolean; verifiedBy: AnchorVerification }> {
  const { stampOnMiss = true } = options;
  const db = await getDb();

  const found = await db.execute({
    args: [trackId],
    sql: `select t.isrc, t.title, t.artists_json, t.duration_ms, t.spotify_uri,
                 (f.track_id is not null) as certified
          from tracks t
          left join findings f on f.track_id = t.track_id
          where t.track_id = ?
          limit 1`,
  });

  const row = typedRows<AnchorRow>(found.rows)[0];

  if (!row) {
    throw new AnchorTrackError("not_found", `No track with id ${trackId}`);
  }

  if (Number(row.certified) === 1) {
    throw new AnchorTrackError(
      "certified",
      `Track ${trackId} is certified — its Spotify id is its identity, not an anchor to fill`,
    );
  }

  if (row.spotify_uri) {
    throw new AnchorTrackError(
      "already_anchored",
      `Track ${trackId} already carries a Spotify anchor`,
    );
  }

  const rowArtists = parseArtistsJson(row.artists_json);
  const durationMs = Number(row.duration_ms);

  // RUNG ONE — exact ISRC. Only when the row carries one; the closest-duration winner takes it.
  let verified: AnchorCandidate | undefined;
  let verifiedBy: AnchorVerification = null;

  if (row.isrc) {
    const isrcHit = pickIsrcCandidate(row.isrc, durationMs, candidates);

    if (isrcHit) {
      verified = isrcHit;
      verifiedBy = "isrc";
    }
  }

  // RUNG TWO — the verified search triple. Reached when the row has no ISRC, or its ISRC found
  // nothing among the candidates. A row with no measured duration cannot clear the triple, so the
  // gate simply returns nothing for it (a permanent no-stamp, correctly).
  if (!verified) {
    const searchHit = pickVerifiedCandidate(
      rowArtists,
      row.title,
      durationMs,
      candidates.map((candidate) => ({
        artists: candidate.artists.map((artist) => artist.name),
        candidate,
        durationMs: candidate.durationMs,
        title: candidate.title,
      })),
    );

    if (searchHit) {
      verified = searchHit.candidate;
      verifiedBy = "search";
    }
  }

  const now = new Date().toISOString();

  if (!verified) {
    // A MISS — leave the row un-anchored. Stamp the attempt so the worklist backs the row off,
    // UNLESS this is the free rung (`stampOnMiss: false`), which must not back a row off before the
    // metered Apify fallback has had its turn on it (see the doc above).
    if (stampOnMiss) {
      await db.execute({
        args: [now, trackId],
        sql: `update tracks set spotify_anchor_attempted_at = ? where track_id = ?`,
      });
    }

    return { anchored: false, verifiedBy: null };
  }

  const spotifyId = verified.spotifyTrackId;

  await db.execute({
    args: [
      `spotify:track:${spotifyId}`,
      `https://open.spotify.com/track/${spotifyId}`,
      verified.albumImageUrl ?? null,
      now,
      trackId,
    ],
    sql: `update tracks
          set spotify_uri = ?,
              spotify_url = ?,
              album_image_url = coalesce(album_image_url, ?),
              spotify_anchor_attempted_at = ?
          where track_id = ?`,
  });

  // Connect the artists by their stable Spotify id, off the SAME candidate — no extra call. A
  // candidate that carried no artist ids simply mints/links nothing (the name-fold already ran at
  // crawl time), so the empty-id case is a safe no-op.
  await connectAnchorArtists(
    trackId,
    verified.artists.map((artist) => artist.name),
    verified.artists.map((artist) => artist.id ?? ""),
  );

  return { anchored: true, verifiedBy };
}

/**
 * THE FREE RUNG of the resolver waterfall — try to anchor a catalogue row from ListenBrainz before
 * any Apify money is spent (docs/catalogue-crawler.md § the anchor).
 *
 * Given the row's MusicBrainz recording MBID (`mb_recording_id`, which a crawler-born row always
 * carries), ListenBrainz labs returns the Spotify track ids for that exact recording, free and with
 * no auth. Those ids carry no ISRC/duration, so this fetches the FIRST id's metadata with ONE
 * `GET /v1/tracks/{id}` — a cheap by-id read, NEVER a search — and runs that single candidate through
 * the SAME `anchorTrack` gate an Apify candidate clears. So the free rung's whole Spotify footprint
 * is: ZERO calls when the row has no MBID or ListenBrainz has no mapping, and exactly ONE `GET` per
 * ListenBrainz hit (the by-id metadata read). It never issues a Spotify SEARCH.
 *
 * It anchors with `stampOnMiss: false`: a HIT writes the anchor + stamps the attempt like any other,
 * but a MISS leaves the row UNSTAMPED, so the same tick's Apify fallback still runs on it (and, if
 * Apify is down, the next tick retries it) rather than backing it off for weeks on a free-rung near
 * miss. Best-effort throughout — a missing MBID, a ListenBrainz miss, or a Spotify metadata fetch
 * that throws (an outage, a dead grant) all resolve to a clean `{ anchored: false }`, and the caller
 * falls through to Apify. The `AnchorTrackError` rails (not_found / certified / already_anchored)
 * still propagate, so the op maps them to the same honest status the Apify path does.
 */
export async function resolveAnchorFree(
  trackId: string,
): Promise<{ anchored: boolean; verifiedBy: AnchorVerification }> {
  const db = await getDb();

  const found = await db.execute({
    args: [trackId],
    sql: `select mb_recording_id from tracks where track_id = ? limit 1`,
  });
  const mbid = typedRows<{ mb_recording_id: null | string }>(found.rows)[0]?.mb_recording_id;

  // No MusicBrainz recording identity ⇒ ListenBrainz cannot map it. A clean miss, zero vendor calls.
  if (!mbid) {
    return { anchored: false, verifiedBy: null };
  }

  const match = await lookupSpotifyIdsByMbid(mbid);
  const spotifyTrackId = match?.spotifyTrackIds[0];

  // ListenBrainz has no Spotify mapping for this recording ⇒ a clean miss, and no Spotify call spent.
  if (!spotifyTrackId) {
    return { anchored: false, verifiedBy: null };
  }

  // ONE by-id metadata read — the only Spotify-quota touch in the free rung, and only on a hit. It
  // gives the candidate its ISRC + duration + title + artists, exactly the signals the gate reads.
  // Best-effort: a Spotify outage / a dead grant throws here, and a candidate we cannot verify is a
  // miss — the row falls through to the Apify fallback un-stamped.
  let metadata;

  try {
    metadata = await fetchTrackMetadata(spotifyTrackId);
  } catch (error) {
    logEvent("warn", "anchor.free-metadata-failed", { error, spotifyTrackId, trackId });

    return { anchored: false, verifiedBy: null };
  }

  const candidate: AnchorCandidate = {
    albumImageUrl: metadata.albumImageUrl ?? null,
    artists: metadata.artists.map((name, index) => ({
      id: metadata.spotifyArtistIds[index] ?? null,
      name,
    })),
    durationMs: metadata.durationMs,
    isrc: metadata.isrc ?? null,
    spotifyTrackId,
    title: metadata.title,
  };

  // The SAME verification gate — but never stamp a miss (Apify still gets its turn on this row).
  return anchorTrack(trackId, [candidate], { stampOnMiss: false });
}
