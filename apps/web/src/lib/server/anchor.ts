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
// NO SOURCE'S VERDICT IS EVER TRUSTED. Not the box's Apify match, not ListenBrainz's mapping, and not
// the Deezer hits the box now fetches for rung 0 (`recoverIsrcViaDeezer`): the SERVER re-runs the full
// verification below against ALL THREE, exactly as it did when it held the calls itself — so a re-baked
// box script (or a wrong ListenBrainz map) can never invent a looser match rule, and the only thing a
// box can change is WHETHER a candidate is offered, never whether one is accepted. This is the
// `verify_capture` doctrine: the sources fetch, the Worker rules.
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
//      AND a duration within ±3s of the row's. Of the candidates that clear it, the closest duration
//      wins. This is the SAME gate the in-Worker fill used, moved here verbatim.
//
// EVERY ATTEMPTED ROW is stamped `spotify_anchor_attempted_at` — a hit AND a miss — so the anchor
// worklist can back a missed row off (track-work.ts `ANCHOR_REASK_AFTER_DAYS`) instead of re-asking
// it every tick (each re-ask is a billed Apify search). See docs/catalogue-crawler.md § the anchor.
//
// ── ONE MISS IS WRITTEN DOWN: THE ANCHOR REVIEW ──────────────────────────────────────────────
// A miss is normally silent, and normally that is right. One class is not: a candidate that agrees
// with the row on artists, base title, and duration (inside 1s) but names a DIFFERENT version. That
// is the fingerprint of MusicBrainz metadata missing the version — a comp track billed plain at the
// remix's length — so the row can never anchor, misses every tick, and retires under the cap with
// nobody the wiser. `detectVersionMismatch` spots exactly that shape after BOTH rungs miss and
// records it on the row (`tracks.anchor_review_json`), where the /admin attention queue reads it and
// the OPERATOR rules with `resolve_anchor_review`. The gate is not loosened by one millisecond: the
// review is evidence beside a miss, never an anchor. See "THE ANCHOR REVIEW" section at the bottom.
//
// The same UPDATE also bumps `spotify_anchor_attempts` (`coalesce(…, 0) + 1`) — the RETRY CAP's
// counter, which is what makes the backoff terminate rather than re-ask forever: at
// `ANCHOR_MAX_ATTEMPTS` full attempts the worklist stops offering the row (track-work.ts). The stamp
// and the counter are written together, always — one attempt, one bump — so neither can drift.

import { isAnchorApifyEnabled } from "./anchor-apify";
import { anchorSpotifySearchAllowed, isAnchorSpotifySearchEnabled } from "./anchor-spotify-search";
import { parseArtistsJson, stampRemixerRoles, upsertTrackArtists } from "./artists";
import { getDb, typedRows } from "./db";
import { type DeezerIsrcCandidate, searchDeezerCandidates } from "./deezer";
import { lookupSpotifyIdsByMbid } from "./listenbrainz";
import { logEvent } from "./log";
import {
  fetchTrackMetadata,
  findSpotifyTrackByIsrc,
  searchTrackCandidates,
  type TrackSearchResult,
} from "./spotify";
import { canonicalizeSearchTitle, matchKey, normalizeArtists, splitTitle } from "./track-match";

/**
 * ±window on the row↔candidate duration match — one of the search rung's three verification
 * signals. 3000, calibrated 2026-07-26 against 397 ISRC-matched same-recording pairs (our MB
 * duration vs Deezer's independent master): same-recording drift P95 ≈ 1.0–1.5s and 3s cuts the
 * false-miss rate by a third (2.0% → 1.3%), while every identity-passing candidate inside 5s in
 * the collision sample was a benign re-press of the SAME recording — the nearest genuinely
 * different recording sat ≥21s out (an empty 5–21s gap), so 3s admits nothing wrong. Widening
 * past 3s stops paying (the residual misses are >15s cross-edit ISRC collisions no sane window
 * recovers). The exact-ISRC rung is NOT gated by this (ISRC equality is the identity there;
 * duration only tiebreaks) — this window guards the search triple and the Deezer ISRC-recovery
 * rung. Raw data + method: the duration-gate calibration run (scripts kept with the session).
 */
export const ANCHOR_DURATION_TOLERANCE_MS = 3000;

/**
 * The TIGHT window the subset fallback demands (see `pickVerifiedCandidate`): a candidate that
 * credits only a SUBSET of the row's artists may still verify, but only this close in duration —
 * the loosened artist signal is paid for with a hardened duration signal. At ≤1s, 20 of 226
 * stable misses in the 2026-07-26 dry-run were recoverable (platforms crediting only the primary
 * artist on a collab — "LSB & DRS" listed as "LSB", Δ0.0s), with the same-recording drift P50 at
 * 0.13s comfortably inside.
 */
export const ANCHOR_SUBSET_DURATION_TOLERANCE_MS = 1000;

/**
 * The free-text query the search rung asks of Spotify — the row's artists, then its title, spelled
 * the way the platforms index it (`canonicalizeSearchTitle`: `rmx` → `Remix`, a redundant trailing
 * `mix` dropped — the retrieval-side twin of the identity fold `anchorTrack`'s gate verifies with,
 * kept in lockstep in ./track-match). Asking for the row's own spelling of a version the platform
 * writes differently returns NOTHING, and a gate handed no candidate cannot forgive anything.
 *
 * ONE owner, every rung: this is what the Worker's search rung sends, and what `list_track_work`
 * hands the box's Apify sweep as each row's ready-made `anchorQuery` (the sweep never builds one).
 */
export function anchorSearchQuery(artists: string[], title: string): string {
  return [...artists, canonicalizeSearchTitle(title)].join(" ").trim();
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

/**
 * Which SIGNAL verified an anchor, or `null` on a miss — persisted as
 * `tracks.spotify_anchor_verified_by` (schema.ts) and served as the identity envelope's
 * `verification.method`.
 *
 * `search-subset` is DISTINCT from `search` on purpose: the ±1s proper-subset fallback loosened the
 * artist signal and paid for it with a hardened duration one, so it is a different confidence and
 * an envelope that flattened the two would overstate what was checked. `operator` is written only
 * by `resolveAnchorReview`'s accept — a human read both titles.
 */
export type AnchorVerification =
  | "isrc"
  | "operator"
  | "publish"
  | "search"
  | "search-subset"
  | null;

/**
 * The subset of {@link AnchorVerification} the automated GATE can return — everything but
 * `operator` (only the human ruling in `resolveAnchorReview` writes it) and `publish` (only the add
 * flow does). Split from the persisted domain so the `anchor_track` / `resolve_anchor` contracts
 * advertise exactly the values their handlers can produce, rather than values no gate path reaches.
 */
export type AnchorGateVerification = Exclude<AnchorVerification, "operator" | "publish">;

/**
 * The domain of `tracks.spotify_anchor_source` — WHICH PATH produced the link. A superset of
 * {@link AnchorReviewSource} by exactly one member, and the split is deliberate:
 * `AnchorReviewSource` is the domain of the REVIEW note's `candidate.source` (the five rungs that
 * can fetch a candidate for the operator to rule on), and `publish` is not one of them — no rung
 * searched, the operator handed over a Spotify URL and Spotify's own API answered. Widening
 * `AnchorReviewSource` itself would let `publish` into a review note where it can never be true.
 */
export type AnchorSource = AnchorReviewSource | "publish";

/** The minimal shape the verified-search gate reads off a candidate. */
type VerifiableCandidate = {
  artists: string[];
  durationMs?: null | number;
  title: string;
};

/**
 * The "closest duration to the row wins" comparator every rung tiebreaks with — the one place the
 * rule is written, shared by the gate, the ISRC rung, and the mismatch detector below. A candidate
 * with no duration sorts as if it were 0 (the gate has already dropped it by then).
 */
function closestTo<T extends { durationMs?: null | number }>(rowDurationMs: number) {
  return (left: T, right: T) =>
    Math.abs((left.durationMs ?? 0) - rowDurationMs) -
    Math.abs((right.durationMs ?? 0) - rowDurationMs);
}

/**
 * THE VERIFIED-SEARCH GATE. A candidate anchors ONLY when it clears ALL THREE signals: the same
 * artist SET, the same base title, and the same version descriptor as the row (all three carried
 * by the ratified `matchKey` fold — which deliberately keeps a remix/VIP descriptor distinct, so
 * the original of a logged VIP can never anchor to the VIP), AND a duration within
 * `ANCHOR_DURATION_TOLERANCE_MS` of the row's. Of the candidates that clear it, the closest
 * duration wins; if none clear it, `undefined` and the row stays in rotation. A candidate with no
 * duration cannot be verified, so it is dropped.
 *
 * THE SUBSET FALLBACK (measured 2026-07-26, ~9% of stable misses): platforms routinely credit
 * only the PRIMARY artist on a collab ("LSB & DRS — Could Be" listed under "LSB" alone), which
 * fails the artist-set equality forever. When no candidate clears the full gate, a candidate
 * whose artist set is a non-empty PROPER SUBSET of the row's may verify instead — same base
 * title, same descriptor, and the TIGHT `ANCHOR_SUBSET_DURATION_TOLERANCE_MS` window: the
 * loosened artist signal is paid for with a hardened duration one. The subset direction is
 * one-way on purpose — a candidate crediting artists the row does NOT name is a different credit
 * (a feat. variant, another act's cover) and still never matches.
 */
export function pickVerifiedCandidate<T extends VerifiableCandidate>(
  rowArtists: string[],
  rowTitle: string,
  rowDurationMs: number,
  candidates: T[],
): T | undefined {
  return verifySearchCandidate(rowArtists, rowTitle, rowDurationMs, candidates)?.candidate;
}

/**
 * {@link pickVerifiedCandidate}, plus WHICH of its two rungs cleared — `"search"` for the full
 * triple, `"search-subset"` for the ±1s proper-subset fallback. The gate has always known this and
 * always discarded it; the anchor write persists it now (`tracks.spotify_anchor_verified_by`), so
 * the identity envelope can say which confidence a link was verified at instead of flattening two
 * genuinely different checks into one word.
 *
 * `pickVerifiedCandidate` stays the shape every non-persisting caller wants (the Deezer
 * ISRC-recovery gate does not care which rung agreed, only that one did), so this is additive.
 */
export function verifySearchCandidate<T extends VerifiableCandidate>(
  rowArtists: string[],
  rowTitle: string,
  rowDurationMs: number,
  candidates: T[],
): undefined | { candidate: T; via: "search" | "search-subset" } {
  const rowKey = matchKey(rowArtists, rowTitle);
  const byClosestDuration = closestTo<T>(rowDurationMs);

  const full = candidates
    .filter(
      (candidate) =>
        typeof candidate.durationMs === "number" &&
        Math.abs(candidate.durationMs - rowDurationMs) <= ANCHOR_DURATION_TOLERANCE_MS &&
        matchKey(candidate.artists, candidate.title) === rowKey,
    )
    .sort(byClosestDuration)[0];

  if (full) {
    return { candidate: full, via: "search" };
  }

  // The subset fallback. Compare base title + descriptor with the row's artist set SUBSTITUTED
  // into the candidate's key, so the title fold stays the ratified one; the artist relation is
  // checked explicitly as a proper, non-empty subset.
  const rowNames = normalizeArtists(rowArtists);

  const subset = candidates
    .filter((candidate) => {
      if (
        typeof candidate.durationMs !== "number" ||
        Math.abs(candidate.durationMs - rowDurationMs) > ANCHOR_SUBSET_DURATION_TOLERANCE_MS
      ) {
        return false;
      }

      const candidateNames = normalizeArtists(candidate.artists);

      if (candidateNames.size === 0 || candidateNames.size >= rowNames.size) {
        return false;
      }

      for (const name of candidateNames) {
        if (!rowNames.has(name)) {
          return false;
        }
      }

      // Titles must agree exactly as they would under the full gate — swap the row's artists in.
      return matchKey(rowArtists, candidate.title) === rowKey;
    })
    .sort(byClosestDuration)[0];

  return subset ? { candidate: subset, via: "search-subset" } : undefined;
}

/**
 * THE SUSPECTED VERSION MISMATCH — the one miss the gate writes DOWN instead of forgetting.
 *
 * A measured class of catalogue rows carries MusicBrainz metadata that OMITS the version: a
 * compilation track billed as plain "Typical Description" at 394s, where streaming holds the plain
 * mix at 313s and "(Calibre Remix)" at 394s. The duration fingerprints it — the row IS the remix,
 * mislabelled upstream — but the descriptor signal (correctly, and permanently) refuses the anchor,
 * so the row misses every tick until it retires under the retry cap. Nobody ever learns why.
 *
 * This detects exactly that shape, and ONLY after both gate rungs have missed: a candidate whose
 * artist set EQUALS the row's or is a non-empty PROPER SUBSET of it (the same one-way relation the
 * subset fallback allows — a candidate crediting artists the row does not name is a different
 * credit, not a mislabelled version), the SAME base title, a duration inside the TIGHT
 * `ANCHOR_SUBSET_DURATION_TOLERANCE_MS` window, and a DIFFERENT version descriptor. The tight
 * window is the whole precision story: at ≤1s the duration is doing the identifying, which is the
 * only reason a descriptor disagreement is readable as an upstream labelling error rather than as
 * two genuinely different recordings. Of the suspects, the closest duration wins.
 *
 * It is EVIDENCE, NEVER AN ANCHOR. The caller records it on the row for the operator's eye
 * (`recordAnchorReview`) and the miss stands exactly as it did before — the never-wrong-stamp rail
 * is the reason this module exists, and a heuristic strong enough to raise a question is nowhere
 * near strong enough to stamp an identity. Only the operator's `resolve_anchor_review` binds it.
 *
 * `undefined` when the row has no measured duration, no artists, or no base title (nothing to
 * fingerprint against, so nothing to suspect), or when no candidate fits the shape.
 */
export function detectVersionMismatch<T extends VerifiableCandidate>(
  rowArtists: string[],
  rowTitle: string,
  rowDurationMs: number,
  candidates: T[],
): T | undefined {
  const rowNames = normalizeArtists(rowArtists);
  const row = splitTitle(rowTitle);

  if (!(rowDurationMs > 0) || rowNames.size === 0 || !row.base) {
    return undefined;
  }

  return candidates
    .filter((candidate) => {
      if (
        typeof candidate.durationMs !== "number" ||
        Math.abs(candidate.durationMs - rowDurationMs) > ANCHOR_SUBSET_DURATION_TOLERANCE_MS
      ) {
        return false;
      }

      const candidateNames = normalizeArtists(candidate.artists);

      // Equal-or-proper-subset, one way (the subset fallback's relation): every credited name
      // must be one the row names, and the row may name more.
      if (candidateNames.size === 0 || candidateNames.size > rowNames.size) {
        return false;
      }

      for (const name of candidateNames) {
        if (!rowNames.has(name)) {
          return false;
        }
      }

      const split = splitTitle(candidate.title);

      // The SAME recording by every signal except the one that names the version — which is
      // precisely the suspicion.
      return split.base === row.base && split.descriptor !== row.descriptor;
    })
    .sort(closestTo<T>(rowDurationMs))[0];
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

/**
 * The catalogue row the anchor targets is missing, certified, or already anchored — plus the two
 * rails the operator's anchor-review ruling adds: the row carries no review to rule on, and the
 * reviewed candidate carries no Spotify id to anchor TO.
 */
export type AnchorTrackReason =
  | "already_anchored"
  | "certified"
  | "no_review"
  | "no_spotify_candidate"
  | "not_found";

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
  options: { source?: AnchorReviewSource; stampOnMiss?: boolean } = {},
): Promise<{ anchored: boolean; verifiedBy: AnchorGateVerification }> {
  const { source = "apify", stampOnMiss = true } = options;
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
  let verifiedBy: AnchorGateVerification = null;

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
    const searchHit = verifySearchCandidate(
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
      verified = searchHit.candidate.candidate;
      // The gate's own word for which rung cleared — "search-subset" when only the ±1s
      // proper-subset fallback agreed. Persisted below, so the envelope never overstates it.
      verifiedBy = searchHit.via;
    }
  }

  const now = new Date().toISOString();

  if (!verified) {
    // BOTH gate rungs missed. Before the row goes back in the pile, ask the ONE question a miss
    // can still answer usefully: was a candidate the same recording under a different version
    // name? A suspect is recorded for the operator's eye and changes NOTHING about the miss —
    // no anchor, no altered stamp — so this write is invisible to every rung and every worklist.
    const suspect = detectVersionMismatch(
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

    if (suspect) {
      await recordAnchorReview(db, trackId, row.title, suspect.candidate, source, now);
    }

    // A MISS — leave the row un-anchored. Stamp the attempt so the worklist backs the row off,
    // UNLESS this is the free rung (`stampOnMiss: false`), which must not back a row off before the
    // metered Apify fallback has had its turn on it (see the doc above).
    if (stampOnMiss) {
      await db.execute({
        args: [now, trackId],
        sql: `update tracks
              set spotify_anchor_attempted_at = ?,
                  spotify_anchor_attempts = coalesce(spotify_anchor_attempts, 0) + 1
              where track_id = ?`,
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
      // The verified candidate's ISRC recovers the recording's real ISRC when our own row lacks
      // one — the crawler's ISRC comes from MusicBrainz, whose ISRC coverage of underground DnB is
      // sparse (an editor-contributed field), so ~60% of catalogue rows arrive ISRC-less even
      // though the track genuinely has one. Spotify carries it, and we already fetched it here to
      // VERIFY the match, so storing it is free. FILL-EMPTY-ONLY via `coalesce`: a real ISRC (an
      // exact-ISRC anchor, or one already present) is never overwritten — the recovered value only
      // fills a NULL. This strengthens dedup (ISRC-equality is the strongest identity signal) and
      // lets a related pressing resolve via the exact ISRC rung instead of fuzzy search.
      verified.isrc?.trim() ? verified.isrc.trim() : null,
      now,
      // THE PROVENANCE PAIR + THE HIT TIME (schema.ts § `spotify_anchor_source`). They ride the
      // SAME statement as `spotify_uri` on purpose: a link and the story of how it was found are
      // one fact, and writing them apart would let a row wear someone else's provenance.
      source,
      verifiedBy,
      now,
      trackId,
    ],
    // The anchor landed, so any suspected-version-mismatch review this row was carrying describes a
    // miss that no longer exists — it is CLEARED here rather than left to nag the operator with a
    // question the machine has now answered itself (the queue's trust rule: never surface a row the
    // system cannot confirm is actionable). Unconditional: clearing a NULL costs nothing.
    sql: `update tracks
          set spotify_uri = ?,
              spotify_url = ?,
              album_image_url = coalesce(album_image_url, ?),
              isrc = coalesce(isrc, ?),
              spotify_anchor_attempted_at = ?,
              spotify_anchor_attempts = coalesce(spotify_anchor_attempts, 0) + 1,
              spotify_anchor_source = ?,
              spotify_anchor_verified_by = ?,
              spotify_anchored_at = ?,
              anchor_review_json = null
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

/** The ListenBrainz rung's exact terminal outcome for this row. */
export type ListenBrainzAnchorOutcome =
  | "anchored"
  | "empty-ids"
  | "gate-rejected"
  | "metadata-failed"
  | "no-map"
  | "no-mbid"
  | "not-attempted"
  | "request-failed";

/**
 * The `resolve_anchor` outcome. `source` names the rung that anchored (or `null` on a miss), so the
 * box sweep can tally per-rung. `spotifySearchDone` is TRUE iff this call issued at least one Spotify
 * SEARCH request against the shared official app — the signal the box's pacer uses to throttle the
 * next call (see anchor-spotify-search.ts). When the dark flag is OFF it is always FALSE (and no
 * `findSpotifyTrackByIsrc` / `searchTrackCandidates` ran) — the load-bearing safety property.
 *
 * `isrcRecoveredByDeezer` is TRUE iff this call recovered a verified ISRC from Deezer into a
 * previously ISRC-less row (the pre-anchor recovery rung, below). It is orthogonal to `anchored`: a
 * recovery can happen and the row still miss every anchor rung this tick — the recovered ISRC is
 * persisted regardless, so the next tick's exact-ISRC rung and dedup both benefit. The box sweep
 * tallies it to measure the recovery rate.
 *
 * `apifyEnabled` reflects the `anchor_apify_enabled` operator kill-flag (default ON, ./anchor-apify.ts)
 * as read for this call — a GLOBAL flag, so every verdict in a tick agrees. When FALSE (out of Apify
 * budget), the box skips the whole Apify actor loop for this tick, and this call has already
 * stamped-and-backed-off the row if it was a genuinely-exhausted full miss (see below).
 */
export type AnchorResolveResult = {
  anchored: boolean;
  apifyEnabled: boolean;
  isrcRecoveredByDeezer: boolean;
  listenbrainzOutcome: ListenBrainzAnchorOutcome;
  source: AnchorResolveSource | null;
  spotifySearchDone: boolean;
  verifiedBy: AnchorGateVerification;
};

/**
 * The free-rung outcome BEFORE the Deezer-recovery + Apify-flag fields are folded in by
 * `resolveAnchorFree` (the Spotify-search rungs never learn of Deezer or the Apify flag).
 */
type FreeResolveOutcome = Omit<
  AnchorResolveResult,
  "apifyEnabled" | "isrcRecoveredByDeezer" | "listenbrainzOutcome"
>;

/** Fetch a Spotify track's metadata and shape it into a verifiable candidate — best-effort. */
async function metadataCandidate(spotifyTrackId: string): Promise<AnchorCandidate | undefined> {
  try {
    const metadata = await fetchTrackMetadata(spotifyTrackId);

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
  } catch (error) {
    logEvent("warn", "anchor.metadata-fetch-failed", { error, spotifyTrackId });

    return undefined;
  }
}

type ListenBrainzResolveResult =
  | {
      outcome: "anchored";
      verifiedBy: Exclude<AnchorGateVerification, null>;
    }
  | {
      outcome: Exclude<ListenBrainzAnchorOutcome, "anchored" | "not-attempted">;
    };

/**
 * THE FREE LISTENBRAINZ RUNG. Given the row's MusicBrainz recording MBID, ListenBrainz labs returns
 * the Spotify track ids for that exact recording (free, no auth). The FIRST id's metadata is fetched
 * with ONE `GET /v1/tracks/{id}` — a cheap by-id read, NEVER a search — and that single candidate runs
 * the SAME `anchorTrack` gate. Every outcome stays distinct (`no-mbid`, `no-map`, `empty-ids`,
 * `request-failed`, `metadata-failed`, `gate-rejected`, or `anchored`) so the box can measure where
 * candidates die. Anchors with `stampOnMiss: false` so a miss leaves the row for the later rungs. The
 * `AnchorTrackError` rails propagate (the caller maps them to status).
 */
async function resolveViaListenBrainz(
  trackId: string,
  mbid: null | string,
): Promise<ListenBrainzResolveResult> {
  if (!mbid?.trim()) {
    return { outcome: "no-mbid" };
  }

  const lookup = await lookupSpotifyIdsByMbid(mbid);

  if (lookup.outcome !== "match") {
    if (lookup.outcome === "no-map") {
      return { outcome: "no-map" };
    }

    if (lookup.outcome === "empty-ids") {
      return { outcome: "empty-ids" };
    }

    if (lookup.outcome === "invalid-mbid") {
      return { outcome: "no-mbid" };
    }

    return { outcome: "request-failed" };
  }

  const spotifyTrackId = lookup.match.spotifyTrackIds[0];

  if (!spotifyTrackId) {
    return { outcome: "empty-ids" };
  }

  const candidate = await metadataCandidate(spotifyTrackId);

  if (!candidate) {
    return { outcome: "metadata-failed" };
  }

  const verdict = await anchorTrack(trackId, [candidate], {
    source: "listenbrainz",
    stampOnMiss: false,
  });

  if (!verdict.anchored || verdict.verifiedBy === null) {
    return { outcome: "gate-rejected" };
  }

  return { outcome: "anchored", verifiedBy: verdict.verifiedBy };
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
): Promise<FreeResolveOutcome> {
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
        const result = await anchorTrack(trackId, [candidate], {
          source: "spotify-isrc",
          stampOnMiss: false,
        });

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
    source: "spotify-search",
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
 * THE PRE-ANCHOR DEEZER ISRC-RECOVERY RUNG. Runs FIRST, and ONLY for an ISRC-less row: the crawler's
 * ISRC comes from MusicBrainz, whose ISRC coverage of underground DnB is sparse, so ~60% of catalogue
 * rows arrive with no ISRC even though the track genuinely HAS one — which forces anchoring down the
 * low-precision FUZZY rung. Deezer is a free, no-auth ISRC oracle: a title+artist search returns hits
 * already carrying the real ISRC + duration. We recover it BEFORE anchoring so the high-precision
 * EXACT-ISRC rungs (ListenBrainz maps + Spotify ISRC search) do the work instead of fuzzy.
 *
 * PRECISION IS PARAMOUNT: the recovered ISRC feeds ISRC-EQUALITY anchoring downstream, so a wrong
 * Deezer match would seed a wrong (and permanent) anchor. Every hit is re-verified against the row to
 * the SAME bar the anchor gate uses — the folded artist-set + base-title identity AND a duration within
 * `ANCHOR_DURATION_TOLERANCE_MS` — via the shared `pickVerifiedCandidate` gate (Deezer's billed
 * `artistName` folds into an artist set through `matchKey`). On any doubt, no recovery: the row simply
 * stays ISRC-less and falls to fuzzy, exactly as before this rung existed.
 *
 * EITHER CONCLUSION IS AN ATTEMPT, and stamps `isrc_attempted_at` (schema.ts) — a recovery and a
 * gate-clean refusal both answer the question. The ONE outcome that does not stamp is an empty
 * candidate list, since `searchDeezerCandidates` returns the same empty array for "Deezer has
 * nothing" and for a quota/network failure; the row stays honestly unattempted rather than wearing
 * a stamp we cannot stand behind.
 *
 * AND THE HIT'S DEEZER ID RIDES ALONG (`tracks.deezer_track_id`, schema.ts). A hit that cleared this
 * gate IS this recording on Deezer, so its id is kept in the same statement with the rung that
 * cleared as its provenance, and `/identity` serves a Deezer link off it. It is free — the id came
 * in the search response that was already read — and it is never kept off an ungated answer.
 *
 * THIS IS ALSO THE ONE PLACE THE DEEZER LEDGER IS WRITTEN (`tracks.backfill_deezer_*`, schema.ts).
 * It is stamped by the two outcomes that settle whether Deezer carries this recording — a hit that
 * cleared the gate WITH an id, and a gate-clean refusal — and by nothing else. The two exits above
 * (an unverifiable row, an empty candidate list) stamp nothing, on exactly the reasoning that already
 * governs `isrc_attempted_at` here, and so does the legacy branch where a cleared hit arrives with no
 * id (see the write below). The ledger is what lets a checked-and-missed row say so: without it, a
 * row this rung had searched and found nothing for would still be reading "Not checked yet".
 *
 * A verified hit's ISRC is written FILL-EMPTY-ONLY (`coalesce(isrc, ?)`, mirroring the anchor-hit
 * write) — a real ISRC is never overwritten (defensive; we only reach here for an ISRC-less row) — and
 * returned so the SAME resolve call carries it forward in memory to the exact-ISRC rungs. Returns
 * `undefined` on a miss (no artist/title/duration to verify against, a Deezer miss, or no hit clears
 * the gate). Best-effort: the Deezer client never throws, so a Deezer outage degrades cleanly to no
 * recovery — anchoring is never broken, only unhelped, on that row.
 *
 * WHO FETCHED THE HITS. `suppliedCandidates` is the box's — the anchor sweep runs the Deezer search
 * from rave-02's own dedicated IP because Deezer's tokenless quota is PER-IP and the Worker's shared
 * Cloudflare edge IPs are saturated by the whole platform (measured: 0 recoveries out of 5,133
 * ISRC-less rows over 3 days from the edge, 25/25 clean from the box; see ./deezer.ts's header). ONLY
 * THE FETCH MOVED: the gate below and the write below are unchanged and still the only thing that can
 * authorise an ISRC, so a box that hands over a wrong hit gets exactly what a wrong Deezer answer
 * always got — a refusal. The box's own verdict is never asked for and there is nothing to trust.
 * PRESENT (even as an EMPTY array) ⇒ the box already searched and this call issues NO Deezer request;
 * ABSENT ⇒ nobody searched yet, so we search here (the certify path, and any caller with no box in
 * front of it). This is the `anchor_track`/Apify precedent: the sources fetch, the Worker rules.
 */
export async function recoverIsrcViaDeezer(
  trackId: string,
  db: Awaited<ReturnType<typeof getDb>>,
  rowArtists: string[],
  rowTitle: string,
  rowDurationMs: number,
  suppliedCandidates?: DeezerIsrcCandidate[],
): Promise<string | undefined> {
  // No stable duration or identity to verify against ⇒ we cannot trust a match, so we do not recover.
  // Checked BEFORE the source split, so a box-supplied hit is held to the same precondition.
  if (!rowTitle.trim() || rowArtists.length === 0 || !(rowDurationMs > 0)) {
    return undefined;
  }

  const candidates =
    suppliedCandidates ?? (await searchDeezerCandidates({ artists: rowArtists, title: rowTitle }));

  if (candidates.length === 0) {
    return undefined;
  }

  // The SAME gate an anchor candidate clears: folded artist-set + base-title identity AND a duration
  // within ±ANCHOR_DURATION_TOLERANCE_MS. Deezer's fuzzy search may lead with a remix — the fold keeps
  // its version descriptor distinct, so the original never recovers a remix's ISRC (and vice-versa).
  //
  // `verifySearchCandidate` rather than `pickVerifiedCandidate` because the Deezer ID kept below
  // has to say WHICH rung agreed (`search` vs the looser `search-subset`), the same distinction the
  // anchor persists. The ISRC decision is byte-for-byte the one it always was: same gate, same
  // candidate, same tiebreak.
  const verified = verifySearchCandidate(
    rowArtists,
    rowTitle,
    rowDurationMs,
    candidates.map((candidate) => ({
      artists: [candidate.artistName],
      deezerTrackId: candidate.deezerTrackId,
      durationMs: candidate.durationMs,
      isrc: candidate.isrc,
      title: candidate.title,
    })),
  );

  const recovered = verified?.candidate.isrc.trim();

  if (!recovered) {
    // A GATE-CLEAN MISS, and therefore a concluded attempt: Deezer answered with candidates and not
    // one of them cleared the identity gate. Stamped (schema.ts § `isrc_attempted_at`) so the row
    // reads "looked, not there" rather than the ambiguous silence — the honest negative is the point
    // of the column. Note where this sits: BELOW the empty-candidates return above, which is
    // deliberately left unstamped, because `searchDeezerCandidates` hands back the same empty array
    // for "Deezer has nothing" and for a quota/network failure, and a throttle is not an answer.
    //
    // THE DEEZER LEDGER RIDES THE SAME STATEMENT (schema.ts § `backfill_deezer_*`), because this is
    // the miss it was built for. The same candidates that failed the ISRC gate failed the DEEZER-ID
    // gate — the id is kept only off a hit that clears, so a gate-clean miss ends with no id — and
    // that is a look CONCLUDED, not a look never taken. Without this stamp the row's receipt would
    // go on claiming "Not checked yet" after Fluncle had checked and come back empty; with it the
    // row reads "Not found · checked <date>". `attempted_at` is a plain assignment (the last
    // concluded look, a moving watermark) and `attempts` increments (the monotone tally the identity
    // envelope prints). `done_at` stays null — nothing resolved — and `failures` stays 0, since this
    // branch IS the clean conclusion rather than the transport failure a streak would back off from.
    const missAt = new Date().toISOString();

    await db.execute({
      args: [missAt, missAt, trackId],
      sql: `update tracks
            set isrc_attempted_at = ?,
                backfill_deezer_attempted_at = ?,
                backfill_deezer_attempts = backfill_deezer_attempts + 1
            where track_id = ?`,
    });

    return undefined;
  }

  // FILL-EMPTY-ONLY, exactly like the anchor-hit write (PR #813): a NULL is filled, a real ISRC is
  // never clobbered. Persisted whether or not a rung then anchors, so the next tick's exact-ISRC rung
  // and the ISRC-equality dedup both benefit even on a full miss this tick. The attempt stamp rides
  // the SAME statement — a recovery is a concluded attempt too, and the pair cannot be written apart.
  //
  // AND THE DEEZER LINK (schema.ts § `deezer_track_id`). The hit that just cleared the anchor's own
  // identity gate is, by that fact, this recording on Deezer — so its id is KEPT rather than dropped,
  // in this same statement, with the rung that cleared as its provenance. Free: no extra request was
  // made for it. The trio is first-write-wins through `coalesce` and moves together, so a row can
  // never wear an id with another id's provenance. Null id (an older box's payload, or a hit Deezer
  // sent without one) binds three nulls and changes nothing.
  //
  // AND THE DEEZER LEDGER (schema.ts § `backfill_deezer_*`), in this same statement — but ONLY when
  // an id actually came back. A hit that cleared the gate AND carried an id is a look concluded, so
  // `attempted_at` moves and `attempts` increments; a tally that counted only misses would be no
  // tally at all. `done_at` follows the id exactly: it coalesces on the same first-write-wins rule
  // and binds the same value as `deezer_verified_at`, so the moment the link was won and the moment
  // the ledger says it resolved can never drift apart.
  //
  // A CLEARED HIT THAT ARRIVED WITHOUT AN ID STAMPS NOTHING, and the reason is the receipt's
  // vocabulary. That branch is a legacy-box-payload defence (`searchDeezerCandidates` sets the id
  // from Deezer's numeric `id`, which it always sends), and on it Deezer demonstrably DOES carry the
  // recording — the ISRC being written on this very line came out of that hit. Stamping would render
  // the row "Not found · checked <date>", and on every other row of that page "Not found" means the
  // look could not identify the recording on that platform, not that a payload omitted a field. No
  // state fits: `absent` misstates the fact and `verified` has no link to show. So the row stays
  // `unattempted`, the same reading this rung already gives every outcome it cannot stand behind.
  const now = new Date().toISOString();
  const deezerTrackId = verified?.candidate.deezerTrackId ?? null;
  const deezerWonAt = deezerTrackId === null ? null : now;

  await db.execute({
    args: [
      recovered,
      now,
      deezerTrackId,
      deezerTrackId === null ? null : (verified?.via ?? null),
      deezerWonAt,
      deezerWonAt,
      deezerTrackId === null ? 0 : 1,
      deezerWonAt,
      trackId,
    ],
    sql: `update tracks
          set isrc = coalesce(isrc, ?),
              isrc_attempted_at = ?,
              deezer_track_id = coalesce(deezer_track_id, ?),
              deezer_verified_by = coalesce(deezer_verified_by, ?),
              deezer_verified_at = coalesce(deezer_verified_at, ?),
              backfill_deezer_attempted_at = coalesce(?, backfill_deezer_attempted_at),
              backfill_deezer_attempts = backfill_deezer_attempts + ?,
              backfill_deezer_done_at = coalesce(backfill_deezer_done_at, ?)
          where track_id = ?`,
  });

  return recovered;
}

/**
 * Stamp a catalogue row's re-ask backoff (`spotify_anchor_attempted_at`, plus the retry-cap counter
 * `spotify_anchor_attempts`) — the SAME write `anchorTrack` makes on a stamped miss.
 * `resolveAnchorFree` calls this ONLY when the Apify kill-flag is OFF and the row is a
 * genuinely-exhausted full miss: with no Apify rung coming to stamp it, the row must back itself off
 * (14 days, track-work.ts `ANCHOR_REASK_AFTER_DAYS`) instead of recirculating every tick.
 *
 * A stamp written while the kill-flag is OFF is a DEFERRAL rather than a real attempt, and the
 * flip-ON requeue undoes both halves of this write together (anchor-apify.ts) — so the counter never
 * accumulates cap budget against rows Apify never actually got its turn on.
 */
async function stampAnchorAttempt(
  db: Awaited<ReturnType<typeof getDb>>,
  trackId: string,
  now: Date,
): Promise<void> {
  await db.execute({
    args: [now.toISOString(), trackId],
    sql: `update tracks
          set spotify_anchor_attempted_at = ?,
              spotify_anchor_attempts = coalesce(spotify_anchor_attempts, 0) + 1
          where track_id = ?`,
  });
}

/**
 * THE OPERATOR REQUEUE (`requeue_anchor`) — clear the named rows' re-ask stamp so the next sweep
 * tick attempts them again NOW rather than after `ANCHOR_REASK_AFTER_DAYS`. The lever for "the
 * resolver just got better, give these rows their shot": a matcher fix, a recovered ISRC, a
 * reviewed candidate. Deliberately clears ONLY the stamp — `spotify_anchor_attempts` (the lifetime
 * cap) stays honest, so a requeue re-times a row's next try without re-arming its bounded spend —
 * and only un-anchored rows qualify (`spotify_uri is null`). Idempotent: already-clear rows and
 * anchored rows count zero. Returns the number of rows actually re-queued.
 */
export async function requeueAnchorStamps(trackIds: string[]): Promise<number> {
  if (trackIds.length === 0) {
    return 0;
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `update tracks
          set spotify_anchor_attempted_at = null
          where track_id in (${placeholders})
            and spotify_uri is null
            and spotify_anchor_attempted_at is not null`,
  });

  return result.rowsAffected;
}

/**
 * THE FREE (non-Apify) RESOLVER RUNGS of the waterfall — try to anchor a catalogue row without any
 * Apify money (docs/catalogue-crawler.md § the anchor). The box's sweep calls this FIRST per row and
 * spends the metered Apify search only when it MISSES.
 *
 * Order: (0) the pre-anchor DEEZER ISRC-recovery rung — ONLY for an ISRC-less row, recover the real
 * ISRC from Deezer's free oracle (verified to the anchor gate's bar) so the exact-ISRC rungs run
 * instead of fuzzy; then (1) the FREE ListenBrainz rung (recording MBID → Spotify ids → one by-id
 * metadata read → gate); then, ONLY when the dark flag `anchor_spotify_search_enabled` is on and we
 * are outside the Friday-refresh window (`anchorSpotifySearchAllowed`), (2) the exact Spotify ISRC
 * search and (3) the fuzzy Spotify search. When the flag is off (or during the Friday window) the
 * Spotify rungs are SKIPPED ENTIRELY: not one `findSpotifyTrackByIsrc` / `searchTrackCandidates` call
 * is issued — the load-bearing safety property that lets slice 2 ship dark.
 *
 * Every rung anchors with `stampOnMiss: false`, so a full miss normally leaves the row UNSTAMPED and
 * the Apify fallback (or the next tick) still gets its turn. THE EXCEPTION is the Apify kill-flag
 * (`anchor_apify_enabled`, default ON, ./anchor-apify.ts): when it is OFF (out of budget) NO Apify rung
 * is coming, so a genuinely-exhausted full miss is stamped-and-backed-off HERE (via `stampAnchorAttempt`)
 * — never a HIT, and never a row whose Spotify search is merely deferred by the Friday window (still
 * pending on a later tick). With the flag ON, behaviour is UNCHANGED (a free-rung miss never stamps).
 * The read is reported as `apifyEnabled` so the box can skip the whole Apify actor loop for the tick.
 *
 * Best-effort throughout — a missing MBID, a Deezer outage, a ListenBrainz miss, a throttle, or a
 * Spotify read that throws all fall through to the later rungs without stamping, but the
 * `listenbrainzOutcome` field keeps those cases distinguishable. The `AnchorTrackError` rails
 * (not_found / certified / already_anchored) still propagate, so the op maps them to the same honest
 * status the Apify path does. `now` is injected for deterministic tests.
 *
 * `options.deezerCandidates` are the Deezer hits the BOX fetched for this row from its own IP (see
 * `recoverIsrcViaDeezer` — only the fetch moved; the gate and the write did not). Present ⇒ rung 0
 * verifies exactly those and issues no Deezer request of its own; absent ⇒ rung 0 searches Deezer here.
 */
export async function resolveAnchorFree(
  trackId: string,
  now: Date = new Date(),
  options: { deezerCandidates?: DeezerIsrcCandidate[] } = {},
): Promise<AnchorResolveResult> {
  const db = await getDb();

  // The Apify-fallback kill-flag (default ON). Read ONCE up front, so every return path reports the
  // same GLOBAL value and the terminal-miss stamping below can consult it. When OFF, the free rungs
  // must back off their own full misses (no Apify rung will).
  const apifyEnabled = await isAnchorApifyEnabled();

  const found = await db.execute({
    args: [trackId],
    sql: `select mb_recording_id, isrc, artists_json, title, duration_ms from tracks where track_id = ? limit 1`,
  });
  const row = typedRows<{
    artists_json: null | string;
    duration_ms: null | number;
    isrc: null | string;
    mb_recording_id: null | string;
    title: null | string;
  }>(found.rows)[0];

  // An unknown track has nothing to resolve — a clean miss, zero vendor calls (slice-1 behaviour).
  if (!row) {
    return {
      anchored: false,
      apifyEnabled,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "not-attempted",
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    };
  }

  const rowArtists = parseArtistsJson(row.artists_json ?? "[]");

  // RUNG 0 — the pre-anchor DEEZER ISRC-recovery rung. ONLY for an ISRC-less row; on a verified hit it
  // persists the ISRC (fill-empty-only) AND carries it forward in memory so the exact-ISRC rungs below
  // run on it this same call (ListenBrainz's `anchorTrack` re-reads the row and sees the persisted
  // value; the Spotify rungs read `isrc` from the in-memory variable). The ISRC-LESS gate is the
  // SERVER's, not the box's: box-supplied hits on a row that already carries an ISRC are ignored here,
  // exactly as a Deezer search would have been.
  let isrc = row.isrc;
  let isrcRecoveredByDeezer = false;

  if (!isrc?.trim()) {
    const recovered = await recoverIsrcViaDeezer(
      trackId,
      db,
      rowArtists,
      row.title ?? "",
      Number(row.duration_ms ?? 0),
      options.deezerCandidates,
    );

    if (recovered) {
      isrc = recovered;
      isrcRecoveredByDeezer = true;
    }
  }

  // RUNG 1 — the FREE ListenBrainz rung.
  const listenbrainz = await resolveViaListenBrainz(trackId, row.mb_recording_id);

  if (listenbrainz.outcome === "anchored") {
    // A HIT already wrote the anchor + stamped the attempt — never re-stamp, regardless of the flag.
    return {
      anchored: true,
      apifyEnabled,
      isrcRecoveredByDeezer,
      listenbrainzOutcome: "anchored",
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: listenbrainz.verifiedBy,
    };
  }

  // THE DARK GATE — off ⇒ zero Spotify search calls. Checked BEFORE either Spotify rung runs.
  if (!(await anchorSpotifySearchAllowed(now))) {
    // The Spotify search rungs will not run this call. With Apify also OFF, this ListenBrainz miss is
    // terminal for the row — but ONLY when the Spotify search flag is genuinely OFF (nothing pending).
    // If that flag is ON we are merely inside the Friday-refresh window and a later tick WILL search,
    // so the row is NOT exhausted and must keep its turn — do NOT stamp it.
    if (!apifyEnabled && !(await isAnchorSpotifySearchEnabled())) {
      await stampAnchorAttempt(db, trackId, now);
    }

    return {
      anchored: false,
      apifyEnabled,
      isrcRecoveredByDeezer,
      listenbrainzOutcome: listenbrainz.outcome,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    };
  }

  // RUNGS 2/3 — the dark Spotify search rungs, fed the (possibly Deezer-recovered) ISRC.
  const searchOutcome = await resolveViaSpotifySearch(trackId, isrc, rowArtists, row.title ?? "");

  // With Apify OFF, a FULL MISS after the Spotify search rungs is terminal — every rung available to
  // the row this call has now been spent — so back it off. (Apify ON ⇒ UNCHANGED: the miss stays
  // un-stamped for the Apify fallback's turn.)
  if (!apifyEnabled && !searchOutcome.anchored) {
    await stampAnchorAttempt(db, trackId, now);
  }

  return {
    ...searchOutcome,
    apifyEnabled,
    isrcRecoveredByDeezer,
    listenbrainzOutcome: listenbrainz.outcome,
  };
}

// ── THE ANCHOR REVIEW: a miss the operator can read ──────────────────────────────────────────
// Everything above is a machine deciding, silently, in one of two directions: anchored, or not.
// That is the right shape for a precision gate and the wrong shape for the one miss that is
// ACTIONABLE — the suspected version mismatch (`detectVersionMismatch`), where the metadata we hold
// is wrong rather than the match. Those rows miss deterministically forever and now retire under
// the retry cap, so a pipeline that discards the near-match discards the only evidence anyone could
// act on. This half writes it down (`tracks.anchor_review_json`), reads it back for the /admin
// attention queue, and lets the OPERATOR — never a machine — either bind the row to the reviewed
// candidate or say it is not a match.
//
// The rails, in one place:
//   - the gate is UNCHANGED. A review is a note beside a miss, never a looser rule.
//   - a review NEVER outlives its miss: any anchor clears it (`anchorTrack`'s hit write), and so
//     does either ruling.
//   - ACCEPTING is operator-only, and refuses a candidate with no Spotify id — there would be
//     nothing to anchor to. Such a review (a Deezer-rung suspect, or one seeded by the backfill
//     script) rides the queue as INFORMATION: the MusicBrainz link so the operator can fix the
//     metadata upstream, and the row re-detects with a Spotify-sourced candidate on a later tick.

/** Why a row is in the operator's anchor-review queue. One reason today; the column is a note, not a flag. */
export type AnchorReviewReason = "version_mismatch";

/**
 * Which rung produced the reviewed candidate — provenance for the operator, never a verdict.
 * `apify` is the default (the box's `anchor_track` POST); `deezer` is reachable only through the
 * backfill script, which may seed a suspect the ISRC-recovery rung noticed.
 */
export type AnchorReviewSource =
  | "apify"
  | "deezer"
  | "listenbrainz"
  | "spotify-isrc"
  | "spotify-search";

/**
 * The reviewed candidate, as stored. It carries everything the ACCEPT write needs so the ruling
 * spends no vendor call: the artists with their stable Spotify ids (so the accepted anchor links
 * the graph exactly as a gate hit does), the cover, the ISRC, and the duration the suspicion was
 * measured on. `spotifyTrackId` is OPTIONAL by design — see the section header.
 */
export type AnchorReviewCandidate = {
  albumImageUrl?: null | string;
  artists: AnchorArtist[];
  durationMs: number;
  isrc?: null | string;
  source: AnchorReviewSource;
  spotifyTrackId?: null | string;
  title: string;
};

/** The stored note itself: the candidate, the row's own title at detection time, why, and when. */
export type AnchorReview = {
  at: string;
  candidate: AnchorReviewCandidate;
  reason: AnchorReviewReason;
  /** The row's title AS IT READ when the suspicion was recorded — the other half of the evidence. */
  title: string;
};

/**
 * The most anchor-review rows the attention queue will ever carry — the `LABEL_REVIEW_QUEUE_LIMIT`
 * discipline. A suspected mismatch is rare, so this cap is not expected to bite; it exists so a bad
 * crawl batch (or a wide backfill seed) can never drown the queue's other thirteen sources in the
 * `/admin` SSR payload, the react-query cache, and the one-per-line CLI + Raycast reads.
 */
export const ANCHOR_REVIEW_QUEUE_LIMIT = 25;

/**
 * Parse a stored review, tolerantly. A row whose JSON is absent, malformed, or shaped wrong reads
 * as NO review (and logs): the column is operator evidence, so a corrupt value must degrade to
 * silence rather than throw on an `/admin` load or wedge the anchor sweep mid-tick.
 */
export function parseAnchorReview(raw: null | string | undefined): AnchorReview | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logEvent("warn", "anchor.review-parse-failed", { error });

    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const review = parsed as Partial<AnchorReview>;
  const candidate = review.candidate;

  if (
    typeof review.at !== "string" ||
    typeof review.title !== "string" ||
    review.reason !== "version_mismatch" ||
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.title !== "string" ||
    typeof candidate.durationMs !== "number" ||
    !Array.isArray(candidate.artists)
  ) {
    logEvent("warn", "anchor.review-shape-invalid", {});

    return undefined;
  }

  return {
    at: review.at,
    candidate: {
      albumImageUrl: candidate.albumImageUrl ?? null,
      artists: candidate.artists.filter(
        (artist): artist is AnchorArtist =>
          typeof artist === "object" && artist !== null && typeof artist.name === "string",
      ),
      durationMs: candidate.durationMs,
      isrc: candidate.isrc ?? null,
      source: candidate.source ?? "apify",
      spotifyTrackId: candidate.spotifyTrackId ?? null,
      title: candidate.title,
    },
    reason: "version_mismatch",
    title: review.title,
  };
}

/**
 * Write (or OVERWRITE) a row's suspected-version-mismatch review. Overwrite is deliberate: a row is
 * re-asked for months, and the NEWEST near-match is the one worth reading — a later rung's suspect
 * is better evidence than a stale one, and keeping a history would turn a note into a ledger nobody
 * reads. Best-effort by design at the call site: the anchor's own stamping is what must not fail.
 */
async function recordAnchorReview(
  db: Awaited<ReturnType<typeof getDb>>,
  trackId: string,
  rowTitle: string,
  candidate: AnchorCandidate,
  source: AnchorReviewSource,
  at: string,
): Promise<void> {
  const review: AnchorReview = {
    at,
    candidate: {
      albumImageUrl: candidate.albumImageUrl ?? null,
      artists: candidate.artists,
      durationMs: candidate.durationMs ?? 0,
      isrc: candidate.isrc ?? null,
      source,
      spotifyTrackId: candidate.spotifyTrackId,
      title: candidate.title,
    },
    reason: "version_mismatch",
    title: rowTitle,
  };

  await db.execute({
    args: [JSON.stringify(review), trackId],
    sql: `update tracks set anchor_review_json = ? where track_id = ?`,
  });
}

/** One anchor-review queue row — the row's identity, the candidate's, and the gap between them. */
export type AnchorReviewRow = {
  /** When the suspicion was recorded — the queue's oldest-first anchor. */
  anchorAt: string;
  artUrl?: string;
  artists: string[];
  candidateArtists: string[];
  /** The candidate's version descriptor ("calibre remix"); "" when IT is the plain one. */
  candidateDescriptor: string;
  /** Present ⇒ the candidate can be anchored to, so Accept is offered. */
  candidateSpotifyTrackId?: string;
  candidateTitle: string;
  /** SIGNED candidate − row duration, in ms. Inside ±1s by construction; the sign is the read. */
  deltaMs: number;
  /** The bare MusicBrainz recording MBID (any `mb_` prefix stripped), when the row carries one. */
  mbRecordingId?: string;
  title: string;
  trackId: string;
};

/**
 * The attention-queue source: every UN-ANCHORED catalogue row carrying a suspected-version-mismatch
 * review, capped at {@link ANCHOR_REVIEW_QUEUE_LIMIT}.
 *
 * The trust rule, as SQL: `spotify_uri is null` (an anchored row's review is history — a hit clears
 * it, and this guards a row anchored by any path that somehow did not) and `dismissed_at is null`
 * (a row the operator already said "not for me" about is not his business). Both ride the tiny
 * partial `tracks_anchor_review_idx`, so this never scans the growing `tracks` table — which
 * matters here more than anywhere: every embedded row carries a 4 KB vector blob that a full scan
 * would drag off the page.
 *
 * Ordered by `track_id` (the index's own order — stable and index-served) rather than by the
 * review's `at`, which lives inside the JSON and would cost a per-row `json_extract` + a sort. The
 * queue's ORDERING is the pure model's job anyway: it sorts every source oldest-first on `anchorAt`.
 */
export async function listAnchorReviewRows(): Promise<AnchorReviewRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [ANCHOR_REVIEW_QUEUE_LIMIT],
    sql: `select track_id, title, artists_json, album_image_url, duration_ms,
                 mb_recording_id, anchor_review_json
          from tracks
          where anchor_review_json is not null
            and spotify_uri is null
            and dismissed_at is null
          order by track_id asc
          limit ?`,
  });

  const rows = typedRows<{
    album_image_url: null | string;
    anchor_review_json: null | string;
    artists_json: null | string;
    duration_ms: null | number;
    mb_recording_id: null | string;
    title: string;
    track_id: string;
  }>(result.rows);

  return rows.flatMap((row): AnchorReviewRow[] => {
    const review = parseAnchorReview(row.anchor_review_json);

    // A row whose note we cannot read is not a row the operator can act on (the trust rule).
    if (!review) {
      return [];
    }

    const mbid = (row.mb_recording_id ?? "").replace(/^mb_/, "").trim();
    const spotifyTrackId = review.candidate.spotifyTrackId?.trim();

    return [
      {
        anchorAt: review.at,
        ...(row.album_image_url ? { artUrl: row.album_image_url } : {}),
        artists: parseArtistsJson(row.artists_json ?? "[]"),
        candidateArtists: review.candidate.artists.map((artist) => artist.name),
        candidateDescriptor: splitTitle(review.candidate.title).descriptor,
        ...(spotifyTrackId ? { candidateSpotifyTrackId: spotifyTrackId } : {}),
        candidateTitle: review.candidate.title,
        deltaMs: review.candidate.durationMs - Number(row.duration_ms ?? 0),
        ...(mbid ? { mbRecordingId: mbid } : {}),
        title: row.title,
        trackId: row.track_id,
      },
    ];
  });
}

/** The operator's two rulings on a held anchor review. */
export type AnchorReviewResolution = "accepted" | "dismissed";

/**
 * THE OPERATOR'S RULING on a suspected version mismatch. The one path by which a review becomes an
 * anchor — and it is operator-tier for the reason the whole module exists: the evidence is a
 * heuristic, and a wrong `spotify_uri` poisons the Telescope playlist and the certify path
 * permanently. A machine may raise the question; only a human may answer it.
 *
 * `accepted` — he read both titles and the candidate IS the row. The anchor is written EXACTLY as a
 * gate hit writes it (uri + url, fill-empty-only cover + ISRC, the attempt stamp and its counter
 * moving together as they always do) and the artists are linked off the SAME stored candidate, so
 * an accepted anchor is indistinguishable from a verified one downstream. Refuses (`no_spotify_
 * candidate`) when the reviewed candidate carries no Spotify id: there is nothing to anchor to, and
 * inventing one is the failure mode this module is built to prevent.
 *
 * `dismissed` — not a match (or the metadata is right and streaming is wrong). The review is cleared
 * and the row keeps its NORMAL lifecycle: same stamp, same counter, same retry cap. Dismissing
 * decides nothing about the row except that this near-match was not it.
 *
 * The rails, before either: the row must EXIST, be UNCERTIFIED, be UN-ANCHORED, and carry a
 * readable review (`no_review`). Each throws `AnchorTrackError` so the op maps it to an honest status.
 */
export async function resolveAnchorReview(
  trackId: string,
  resolution: AnchorReviewResolution,
  now: Date = new Date(),
): Promise<{ anchored: boolean; review: AnchorReview }> {
  const db = await getDb();

  const found = await db.execute({
    args: [trackId],
    sql: `select t.isrc, t.title, t.spotify_uri, t.anchor_review_json,
                 (f.track_id is not null) as certified
          from tracks t
          left join findings f on f.track_id = t.track_id
          where t.track_id = ?
          limit 1`,
  });

  const row = typedRows<{
    anchor_review_json: null | string;
    certified: number;
    isrc: null | string;
    spotify_uri: null | string;
    title: string;
  }>(found.rows)[0];

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

  const review = parseAnchorReview(row.anchor_review_json);

  if (!review) {
    throw new AnchorTrackError("no_review", `Track ${trackId} carries no anchor review to rule on`);
  }

  if (resolution === "dismissed") {
    await db.execute({
      args: [trackId],
      sql: `update tracks set anchor_review_json = null where track_id = ?`,
    });

    return { anchored: false, review };
  }

  const spotifyId = review.candidate.spotifyTrackId?.trim();

  if (!spotifyId) {
    throw new AnchorTrackError(
      "no_spotify_candidate",
      `The reviewed candidate for ${trackId} carries no Spotify track id to anchor to`,
    );
  }

  // The gate's hit write, verbatim (see `anchorTrack`) — plus clearing the review the ruling settles.
  await db.execute({
    args: [
      `spotify:track:${spotifyId}`,
      `https://open.spotify.com/track/${spotifyId}`,
      review.candidate.albumImageUrl ?? null,
      review.candidate.isrc?.trim() ? review.candidate.isrc.trim() : null,
      now.toISOString(),
      // `verified_by = 'operator'`, and `source` left NULL: no rung found this link — he did, off
      // evidence a rung could only raise as a question. These are the best-provenance anchors in
      // the corpus and the envelope must never read them as legacy (schema.ts § the pair).
      now.toISOString(),
      trackId,
    ],
    sql: `update tracks
          set spotify_uri = ?,
              spotify_url = ?,
              album_image_url = coalesce(album_image_url, ?),
              isrc = coalesce(isrc, ?),
              spotify_anchor_attempted_at = ?,
              spotify_anchor_attempts = coalesce(spotify_anchor_attempts, 0) + 1,
              spotify_anchor_source = null,
              spotify_anchor_verified_by = 'operator',
              spotify_anchored_at = ?,
              anchor_review_json = null
          where track_id = ?`,
  });

  await connectAnchorArtists(
    trackId,
    review.candidate.artists.map((artist) => artist.name),
    review.candidate.artists.map((artist) => artist.id ?? ""),
  );

  logEvent("info", "anchor.review-accepted", { spotifyId, trackId });

  return { anchored: true, review };
}
