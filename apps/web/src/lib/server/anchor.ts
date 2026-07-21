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
// (docs/agents/hermes/scripts/anchor-sweep.*). That sweep runs a resolver waterfall per row, all
// resolved through the ONE `resolve_anchor` call the box makes FIRST — only a full miss spends Apify:
//   1. THE FREE LISTENBRAINZ RUNG (`resolveAnchorFree`, below). ListenBrainz labs maps the row's
//      MusicBrainz recording MBID → Spotify track ids for free, with no auth (lib/server/
//      listenbrainz.ts). The first id's metadata is fetched with ONE `GET /v1/tracks/{id}` (a cheap
//      by-id read, never a search) to get its ISRC + duration, and that candidate runs the gate below.
//   2/3. THE SPOTIFY SEARCH RUNGS (slice 2, DARK). When the free rung misses, and ONLY when the dark
//      flag `anchor_spotify_search_enabled` is on and we are outside the Friday-refresh window
//      (lib/server/anchor-spotify-search.ts), the row is resolved against the official Spotify app's
//      SEARCH: first `findSpotifyTrackByIsrc` (the exact ISRC key lookup), then `searchTrackCandidates`
//      (the fuzzy fallback for a no-ISRC row or an ISRC miss). Each candidate runs the SAME gate. This
//      is free in dollars but shares the official app's rate budget with user-facing mints, so it ships
//      default-OFF and the box paces it under a 60/min ceiling (see anchor-spotify-search.ts).
//   4. THE APIFY FALLBACK (`anchorTrack`). Only when EVERY free rung above misses does the box spend
//      the metered Apify search actor, map its results to candidates, and POST them to `anchor_track`.
// So Apify became the last resort: a hit on any earlier rung spends no Apify money, and an Apify outage
// still leaves the free rungs anchoring their share (graceful degradation). When the dark flag is OFF,
// the official Spotify app serves ONLY user-facing paths (adds, publish, the Frontier playlist mints)
// plus the free rung's one by-id metadata read per hit — never a catalogue search.
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

import { anchorSpotifySearchAllowed } from "./anchor-spotify-search";
import { parseArtistsJson, stampRemixerRoles, upsertTrackArtists } from "./artists";
import { getDb, typedRows } from "./db";
import { lookupSpotifyIdsByMbid } from "./listenbrainz";
import { logEvent } from "./log";
import {
  fetchTrackMetadata,
  findSpotifyTrackByIsrc,
  searchTrackCandidates,
  type TrackSearchResult,
} from "./spotify";
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

/** Which rung of the free (non-Apify) resolver waterfall anchored a row, or `null` on a full miss. */
export type AnchorResolveSource = "listenbrainz" | "spotify-isrc" | "spotify-search";

/**
 * The `resolve_anchor` outcome. `source` names the rung that anchored (or `null` on a miss), so the
 * box sweep can tally per-rung. `spotifySearchDone` is TRUE iff this call issued at least one Spotify
 * SEARCH request against the shared official app — the signal the box's pacer uses to throttle the
 * next call (see anchor-spotify-search.ts). When the dark flag is OFF it is always FALSE (and no
 * `findSpotifyTrackByIsrc` / `searchTrackCandidates` ran) — the load-bearing safety property.
 */
export type AnchorResolveResult = {
  anchored: boolean;
  source: AnchorResolveSource | null;
  spotifySearchDone: boolean;
  verifiedBy: AnchorVerification;
};

/** Fetch a Spotify track's metadata and shape it into a verifiable candidate — best-effort. */
async function metadataCandidate(spotifyTrackId: string): Promise<AnchorCandidate | undefined> {
  let metadata;

  try {
    metadata = await fetchTrackMetadata(spotifyTrackId);
  } catch (error) {
    logEvent("warn", "anchor.metadata-fetch-failed", { error, spotifyTrackId });

    return undefined;
  }

  return {
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
}

/**
 * THE FREE LISTENBRAINZ RUNG. Given the row's MusicBrainz recording MBID, ListenBrainz labs returns
 * the Spotify track ids for that exact recording (free, no auth). The FIRST id's metadata is fetched
 * with ONE `GET /v1/tracks/{id}` — a cheap by-id read, NEVER a search — and that single candidate runs
 * the SAME `anchorTrack` gate. Returns `null` on any pre-verify miss (no MBID, no mapping, a metadata
 * read that threw); otherwise the gate's verdict. Anchors with `stampOnMiss: false` so a miss leaves
 * the row for the later rungs. The `AnchorTrackError` rails propagate (the caller maps them to status).
 */
async function resolveViaListenBrainz(
  trackId: string,
  mbid: null | string,
): Promise<{ anchored: boolean; verifiedBy: AnchorVerification } | null> {
  if (!mbid) {
    return null;
  }

  const match = await lookupSpotifyIdsByMbid(mbid);
  const spotifyTrackId = match?.spotifyTrackIds[0];

  if (!spotifyTrackId) {
    return null;
  }

  const candidate = await metadataCandidate(spotifyTrackId);

  if (!candidate) {
    return null;
  }

  return anchorTrack(trackId, [candidate], { stampOnMiss: false });
}

/**
 * Map a Spotify search result to a verified-search candidate. The search result already carries the
 * candidate's duration + title + artists — every signal the search-triple gate reads — so no extra
 * by-id metadata read is spent. It carries no ISRC, so these candidates only ever clear the gate via
 * the search triple (never the ISRC-equality rung), which is exactly the fuzzy rung's role.
 */
function searchResultCandidate(result: TrackSearchResult): AnchorCandidate {
  return {
    albumImageUrl: result.artworkUrl ?? null,
    artists: result.artists.map((name, index) => ({
      id: result.spotifyArtistIds?.[index] ?? null,
      name,
    })),
    durationMs: result.durationMs ?? null,
    isrc: null,
    spotifyTrackId: result.id,
    title: result.title,
  };
}

/**
 * THE DARK SPOTIFY SEARCH RUNGS (slice 2). Reached only after a ListenBrainz miss AND only when
 * `anchorSpotifySearchAllowed` is true — so a caller that never reaches here has issued ZERO Spotify
 * search calls (the load-bearing property is enforced by the caller, below).
 *
 *   RUNG 2 — exact ISRC. Only when the row carries an ISRC: `findSpotifyTrackByIsrc` finds the id, and
 *   we fetch its OWN metadata (the honest re-derivation — the box's/query's word is never trusted) and
 *   run it through the gate, where the ISRC-equality rung fires when the candidate's real ISRC matches.
 *   A throttle (429) or a dead grant STOPS the row here — no second search is spent — and it falls to
 *   Apify: yielding the shared token to the user-facing paths is the whole point of the low ceiling.
 *
 *   RUNG 3 — the verified fuzzy search. For a no-ISRC row, or when the ISRC rung missed:
 *   `searchTrackCandidates` returns up to 8 candidates, fed straight through the search-triple gate.
 *
 * `spotifySearchDone` is set the moment the first search is issued, so the box paces even on a miss.
 * A HIT anchors with `stampOnMiss: false` (a miss stays open for Apify), so this never stamps a miss.
 */
async function resolveViaSpotifySearch(
  trackId: string,
  isrc: null | string,
  artists: string[],
  title: string,
): Promise<AnchorResolveResult> {
  // RUNG 2 — the exact ISRC search, only for a row that carries one.
  if (isrc?.trim()) {
    const lookup = await findSpotifyTrackByIsrc(isrc);

    // A throttle or a dead grant: do NOT spend the fuzzy search too — back off and fall to Apify.
    if (lookup.rateLimited || lookup.unauthorized) {
      return { anchored: false, source: null, spotifySearchDone: true, verifiedBy: null };
    }

    if (lookup.match) {
      const candidate = await metadataCandidate(lookup.match.trackId);

      if (candidate) {
        const result = await anchorTrack(trackId, [candidate], { stampOnMiss: false });

        if (result.anchored) {
          return {
            anchored: true,
            source: "spotify-isrc",
            spotifySearchDone: true,
            verifiedBy: result.verifiedBy,
          };
        }
      }
    }
  }

  // RUNG 3 — the verified fuzzy search (a no-ISRC row, or an ISRC miss). Best-effort: a search that
  // throws is a miss, and the row falls to Apify un-stamped.
  let candidates: TrackSearchResult[];

  try {
    candidates = await searchTrackCandidates(anchorSearchQuery(artists, title));
  } catch (error) {
    logEvent("warn", "anchor.spotify-search-failed", { error, trackId });

    return { anchored: false, source: null, spotifySearchDone: true, verifiedBy: null };
  }

  const result = await anchorTrack(trackId, candidates.map(searchResultCandidate), {
    stampOnMiss: false,
  });

  return {
    anchored: result.anchored,
    source: result.anchored ? "spotify-search" : null,
    spotifySearchDone: true,
    verifiedBy: result.verifiedBy,
  };
}

/**
 * THE FREE (non-Apify) RESOLVER RUNGS of the waterfall — try to anchor a catalogue row without any
 * Apify money (docs/catalogue-crawler.md § the anchor). The box's sweep calls this FIRST per row and
 * spends the metered Apify search only when it MISSES.
 *
 * Order: (1) the FREE ListenBrainz rung (recording MBID → Spotify ids → one by-id metadata read →
 * gate); then, ONLY when the dark flag `anchor_spotify_search_enabled` is on and we are outside the
 * Friday-refresh window (`anchorSpotifySearchAllowed`), (2) the exact Spotify ISRC search and (3) the
 * fuzzy Spotify search. When the flag is off (or during the Friday window) the Spotify rungs are
 * SKIPPED ENTIRELY: not one `findSpotifyTrackByIsrc` / `searchTrackCandidates` call is issued — the
 * load-bearing safety property that lets slice 2 ship dark.
 *
 * Every rung anchors with `stampOnMiss: false`, so a full miss leaves the row UNSTAMPED and the Apify
 * fallback (or the next tick) still gets its turn. Best-effort throughout — a missing MBID, a
 * ListenBrainz miss, a throttle, or a Spotify read that throws all resolve to a clean miss. The
 * `AnchorTrackError` rails (not_found / certified / already_anchored) still propagate, so the op maps
 * them to the same honest status the Apify path does. `now` is injected for deterministic tests.
 */
export async function resolveAnchorFree(
  trackId: string,
  now: Date = new Date(),
): Promise<AnchorResolveResult> {
  const db = await getDb();

  const found = await db.execute({
    args: [trackId],
    sql: `select mb_recording_id, isrc, artists_json, title from tracks where track_id = ? limit 1`,
  });
  const row = typedRows<{
    artists_json: null | string;
    isrc: null | string;
    mb_recording_id: null | string;
    title: null | string;
  }>(found.rows)[0];

  // An unknown track has nothing to resolve — a clean miss, zero vendor calls (slice-1 behaviour).
  if (!row) {
    return { anchored: false, source: null, spotifySearchDone: false, verifiedBy: null };
  }

  // RUNG 1 — the FREE ListenBrainz rung.
  const listenbrainz = await resolveViaListenBrainz(trackId, row.mb_recording_id);

  if (listenbrainz?.anchored) {
    return {
      anchored: true,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: listenbrainz.verifiedBy,
    };
  }

  // THE DARK GATE — off ⇒ zero Spotify search calls. Checked BEFORE either Spotify rung runs.
  if (!(await anchorSpotifySearchAllowed(now))) {
    return { anchored: false, source: null, spotifySearchDone: false, verifiedBy: null };
  }

  // RUNGS 2/3 — the dark Spotify search rungs.
  return resolveViaSpotifySearch(
    trackId,
    row.isrc,
    parseArtistsJson(row.artists_json ?? "[]"),
    row.title ?? "",
  );
}
