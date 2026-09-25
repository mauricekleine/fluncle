import { chargeAnchorApifyRow, getAnchorApifyBudget, isAnchorApifyEnabled } from "./anchor-apify";
import {
  anchorSpotifyBreakerAllows,
  anchorSpotifySearchAllowed,
  anchorSpotifySearchGate,
  type AnchorSpotifyGateReason,
  isAnchorSpotifySearchEnabled,
  recordAnchorSpotifyCall,
} from "./anchor-spotify-search";
import { parseArtistsJson, stampRemixerRoles, upsertTrackArtists } from "./artists";
import { getDb, typedRows } from "./db";
import {
  batchDueWorkSourceMutation,
  markDueWorkSourceMaintenanceFromSelectStatements,
} from "./due-work";
import { type DeezerIsrcCandidate, searchDeezerCandidates } from "./deezer";
import { FILL_ISRC_SQL } from "./isrc";
import { lookupSpotifyIdsByMbid } from "./listenbrainz";
import { logEvent } from "./log";
import { updateTrackDuplicateIsrcStatement } from "./track-duplicate-keys";
import { ANCHOR_MAX_ATTEMPTS } from "./track-work";
import {
  fetchTrackMetadata,
  findSpotifyTrackByIsrc,
  searchTrackCandidates,
  type TrackSearchResult,
} from "./spotify";
import { canonicalizeSearchTitle, matchKey, normalizeArtists, splitTitle } from "./track-match";

export const ANCHOR_DURATION_TOLERANCE_MS = 3000;

export const ANCHOR_SUBSET_DURATION_TOLERANCE_MS = 1000;

export function anchorSearchQuery(artists: string[], title: string): string {
  return [...artists, canonicalizeSearchTitle(title)].join(" ").trim();
}

export type AnchorArtist = { id?: null | string; name: string };

export type AnchorCandidate = {
  albumImageUrl?: null | string;
  artists: AnchorArtist[];
  durationMs?: null | number;
  isrc?: null | string;
  spotifyTrackId: string;
  title: string;
};

export type AnchorVerification =
  | "isrc"
  | "operator"
  | "publish"
  | "search"
  | "search-subset"
  | null;

export type AnchorGateVerification = Exclude<AnchorVerification, "operator" | "publish">;

export type AnchorSource = AnchorReviewSource | "publish";

type VerifiableCandidate = {
  artists: string[];
  durationMs?: null | number;
  title: string;
};

function closestTo<T extends { durationMs?: null | number }>(rowDurationMs: number) {
  return (left: T, right: T) =>
    Math.abs((left.durationMs ?? 0) - rowDurationMs) -
    Math.abs((right.durationMs ?? 0) - rowDurationMs);
}

export function pickVerifiedCandidate<T extends VerifiableCandidate>(
  rowArtists: string[],
  rowTitle: string,
  rowDurationMs: number,
  candidates: T[],
): T | undefined {
  return verifySearchCandidate(rowArtists, rowTitle, rowDurationMs, candidates)?.candidate;
}

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

      return matchKey(rowArtists, candidate.title) === rowKey;
    })
    .sort(byClosestDuration)[0];

  return subset ? { candidate: subset, via: "search-subset" } : undefined;
}

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

      if (candidateNames.size === 0 || candidateNames.size > rowNames.size) {
        return false;
      }

      for (const name of candidateNames) {
        if (!rowNames.has(name)) {
          return false;
        }
      }

      const split = splitTitle(candidate.title);

      return split.base === row.base && split.descriptor !== row.descriptor;
    })
    .sort(closestTo<T>(rowDurationMs))[0];
}

type IsrcCandidate = {
  durationMs?: null | number;
  isrc?: null | string;
};

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

    await stampRemixerRoles([trackId]);
  } catch (error) {
    logEvent("warn", "anchor.artist-link-failed", { error, trackId });
  }
}

type AnchorRow = {
  artists_json: string;
  certified: number;
  duration_ms: number;
  isrc: null | string;
  spotify_anchor_paid_admitted_at: null | string;
  spotify_isrc_asked_at: null | string;
  spotify_uri: null | string;
  title: string;
};

export type AnchorApifyIneligibleReason = "apify_budget_spent" | "awaiting_free_ask";

export type AnchorTrackReason =
  | "already_anchored"
  | "awaiting_free_ask"
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

export const ANCHOR_INVALID_FAILURE_LIMIT = 3;
export const ANCHOR_PAID_ADMISSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

async function assertPaidAnchorAdmission(
  row: AnchorRow,
  trackId: string,
  source: AnchorReviewSource,
): Promise<void> {
  if (source !== "apify") {
    return;
  }
  const paidAdmittedAt = Date.parse(row.spotify_anchor_paid_admitted_at ?? "");
  const paidAdmissionLive =
    Number.isFinite(paidAdmittedAt) &&
    Date.now() >= paidAdmittedAt &&
    Date.now() - paidAdmittedAt <= ANCHOR_PAID_ADMISSION_MAX_AGE_MS;
  if (paidAdmissionLive) {
    return;
  }
  const gateReason = (await anchorSpotifySearchGate(new Date())).reason;
  if (gateReason === "friday_window") {
    throw new AnchorTrackError("awaiting_free_ask", `Track ${trackId} waits for the Friday window`);
  }
  if (
    row.isrc?.trim() &&
    !row.spotify_isrc_asked_at &&
    (await isAnchorSpotifySearchEnabled()) &&
    gateReason !== "breaker_quota"
  ) {
    throw new AnchorTrackError(
      "awaiting_free_ask",
      `Track ${trackId} has not been asked of the free exact-ISRC rung yet — the paid rung is not eligible for it`,
    );
  }
}

export async function recordAnchorValidationFailure(
  trackId: string,
  status: number,
  now: Date = new Date(),
): Promise<{ attempts: number; terminal: boolean }> {
  if (status !== 400 && status !== 422) {
    throw new Error("Only deterministic 4xx anchor failures can be recorded");
  }
  const db = await getDb();
  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [status, now.toISOString(), trackId],
        sql: `update tracks
            set spotify_anchor_invalid_attempts = spotify_anchor_invalid_attempts + 1,
                spotify_anchor_attempts = case
                  when spotify_anchor_invalid_attempts + 1 >= ${ANCHOR_INVALID_FAILURE_LIMIT} then ${ANCHOR_MAX_ATTEMPTS}
                  else spotify_anchor_attempts end,
                spotify_anchor_terminal_error = case
                  when spotify_anchor_invalid_attempts + 1 >= ${ANCHOR_INVALID_FAILURE_LIMIT} then 'http_' || cast(? as integer)
                  else spotify_anchor_terminal_error end,
                spotify_anchor_attempted_at = case
                  when spotify_anchor_invalid_attempts + 1 >= ${ANCHOR_INVALID_FAILURE_LIMIT} then ?
                  else spotify_anchor_attempted_at end
            where track_id = ? and spotify_uri is null and spotify_anchor_terminal_error is null`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "anchor-stamp" },
  );
  const result = await db.execute({
    args: [trackId],
    sql: `select spotify_anchor_invalid_attempts as attempts,
                 spotify_anchor_terminal_error as terminal_error
          from tracks where track_id = ? limit 1`,
  });
  const row = typedRows<{ attempts: number; terminal_error: null | string }>(result.rows)[0];
  return { attempts: Number(row?.attempts ?? 0), terminal: Boolean(row?.terminal_error) };
}

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
                 t.spotify_isrc_asked_at, t.spotify_anchor_paid_admitted_at,
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

  await assertPaidAnchorAdmission(row, trackId, source);

  const rowArtists = parseArtistsJson(row.artists_json);
  const durationMs = Number(row.duration_ms);

  let verified: AnchorCandidate | undefined;
  let verifiedBy: AnchorGateVerification = null;

  if (row.isrc) {
    const isrcHit = pickIsrcCandidate(row.isrc, durationMs, candidates);

    if (isrcHit) {
      verified = isrcHit;
      verifiedBy = "isrc";
    }
  }

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

      verifiedBy = searchHit.via;
    }
  }

  const now = new Date().toISOString();

  if (!verified) {
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

    if (stampOnMiss) {
      await batchDueWorkSourceMutation(
        db,
        [
          {
            args: [now, trackId],

            sql: `update tracks
                  set spotify_anchor_attempted_at = ?,
                      spotify_anchor_attempts = coalesce(spotify_anchor_attempts, 0) + 1,
                      spotify_isrc_asked_at = null,
                      spotify_anchor_invalid_attempts = 0
                  where track_id = ?`,
          },
        ],
        [{ subjectId: trackId, subjectType: "track" }],
        { producer: "anchor-miss" },
      );
    }

    return { anchored: false, verifiedBy: null };
  }

  const spotifyId = verified.spotifyTrackId;
  const candidateIsrc = verified.isrc?.trim() ? verified.isrc.trim() : null;
  const expectedIsrc = row.isrc ?? candidateIsrc;

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [
          `spotify:track:${spotifyId}`,
          `https://open.spotify.com/track/${spotifyId}`,
          verified.albumImageUrl ?? null,

          candidateIsrc,
          candidateIsrc,
          now,

          source,
          verifiedBy,
          now,
          trackId,
        ],

        sql: `update tracks
          set spotify_uri = ?,
              spotify_url = ?,
              album_image_url = coalesce(album_image_url, ?),
              ${FILL_ISRC_SQL},
              spotify_anchor_attempted_at = ?,
              spotify_anchor_attempts = coalesce(spotify_anchor_attempts, 0) + 1,
              spotify_anchor_source = ?,
              spotify_anchor_verified_by = ?,
              spotify_anchored_at = ?,
              anchor_review_json = null,
              -- The free exact-ISRC ask receipt dies with the question it was evidence about
              -- (schema.ts, spotify_isrc_asked_at): this row is anchored, so there is nothing
              -- left to ask and nothing left to authorise.
              spotify_isrc_asked_at = null,
              spotify_anchor_invalid_attempts = 0
          where track_id = ?`,
      },
      updateTrackDuplicateIsrcStatement(trackId, expectedIsrc),
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "anchor-hit" },
  );

  await connectAnchorArtists(
    trackId,
    verified.artists.map((artist) => artist.name),
    verified.artists.map((artist) => artist.id ?? ""),
  );

  return { anchored: true, verifiedBy };
}

export type AnchorResolveSource = "listenbrainz" | "spotify-isrc" | "spotify-search";

export type ListenBrainzAnchorOutcome =
  | "anchored"
  | "empty-ids"
  | "gate-rejected"
  | "metadata-failed"
  | "no-map"
  | "no-mbid"
  | "not-attempted"
  | "request-failed"
  | "yielded-on-breaker";

export type AnchorResolveResult = {
  anchored: boolean;

  apifyBudgetRemaining: number;

  apifyEligible: boolean;

  apifyIneligibleReason: AnchorApifyIneligibleReason | null;
  apifyEnabled: boolean;

  freeDurationMsOmitted: number;
  isrcRecoveredByDeezer: boolean;
  listenbrainzOutcome: ListenBrainzAnchorOutcome;
  source: AnchorResolveSource | null;
  spotifyIsrcAsked: boolean;
  spotifySearchDone: boolean;
  spotifySearchEnabled: boolean;
  spotifyThrottled: boolean;
  stamped: boolean;
  verifiedBy: AnchorGateVerification;
};

type FreeResolveOutcome = Omit<
  AnchorResolveResult,
  | "apifyBudgetRemaining"
  | "apifyEligible"
  | "apifyEnabled"
  | "apifyIneligibleReason"
  | "isrcRecoveredByDeezer"
  | "listenbrainzOutcome"
  | "spotifySearchEnabled"
  | "stamped"
> & {
  spotifyIsrcCleanMiss: boolean;
};

const NO_SPOTIFY_OUTCOME: FreeResolveOutcome = {
  anchored: false,
  freeDurationMsOmitted: 0,
  source: null,
  spotifyIsrcAsked: false,
  spotifyIsrcCleanMiss: false,
  spotifySearchDone: false,
  spotifyThrottled: false,
  verifiedBy: null,
};

function isSpotifyThrottle(error: unknown): boolean {
  return error instanceof Error && error.message.includes("429");
}

async function metadataCandidate(
  spotifyTrackId: string,
  now: Date,
): Promise<{ candidate: AnchorCandidate | undefined; throttled: boolean }> {
  try {
    const metadata = await fetchTrackMetadata(spotifyTrackId);

    return {
      candidate: {
        albumImageUrl: metadata.albumImageUrl ?? null,
        artists: metadata.artists.map((name, index) => ({
          id: metadata.spotifyArtistIds[index] ?? null,
          name,
        })),
        durationMs: metadata.durationMs,
        isrc: metadata.isrc ?? null,
        spotifyTrackId,
        title: metadata.title,
      },
      throttled: false,
    };
  } catch (error) {
    logEvent("warn", "anchor.metadata-fetch-failed", { error, spotifyTrackId });

    return { candidate: undefined, throttled: isSpotifyThrottle(error) };
  } finally {
    await recordAnchorSpotifyCall(now);
  }
}

type ListenBrainzResolveResult = {
  durationMsOmitted?: number;

  throttled?: boolean;
} & (
  | {
      outcome: "anchored";
      verifiedBy: Exclude<AnchorGateVerification, null>;
    }
  | {
      outcome: Exclude<ListenBrainzAnchorOutcome, "anchored" | "not-attempted">;
    }
);

async function resolveViaListenBrainz(
  trackId: string,
  mbid: null | string,
  now: Date,
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

  if (!(await anchorSpotifyBreakerAllows(now))) {
    return { outcome: "yielded-on-breaker" };
  }

  const read = await metadataCandidate(spotifyTrackId, now);

  if (!read.candidate) {
    return { outcome: "metadata-failed", throttled: read.throttled };
  }

  const verdict = await anchorTrack(trackId, [read.candidate], {
    source: "listenbrainz",
    stampOnMiss: false,
  });

  if (!verdict.anchored || verdict.verifiedBy === null) {
    return {
      durationMsOmitted: typeof read.candidate.durationMs === "number" ? 0 : 1,
      outcome: "gate-rejected",
    };
  }

  return {
    durationMsOmitted: typeof read.candidate.durationMs === "number" ? 0 : 1,
    outcome: "anchored",
    verifiedBy: verdict.verifiedBy,
  };
}

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

async function resolveViaSpotifySearch(
  trackId: string,
  isrc: null | string,
  artists: string[],
  title: string,
  now: Date,
): Promise<FreeResolveOutcome> {
  let freeDurationMsOmitted = 0;

  let spotifyIsrcCleanMiss = false;

  if (isrc?.trim()) {
    const lookup = await findSpotifyTrackByIsrc(isrc);
    await recordAnchorSpotifyCall(now);

    if (lookup.rateLimited || lookup.unauthorized) {
      return {
        ...NO_SPOTIFY_OUTCOME,
        spotifyIsrcAsked: true,
        spotifySearchDone: true,
        spotifyThrottled: Boolean(lookup.rateLimited),
      };
    }

    if (!lookup.match) {
      spotifyIsrcCleanMiss = true;
    }

    if (lookup.match) {
      const read = await metadataCandidate(lookup.match.trackId, now);

      if (read.throttled) {
        return {
          ...NO_SPOTIFY_OUTCOME,
          spotifyIsrcAsked: true,
          spotifySearchDone: true,
          spotifyThrottled: true,
        };
      }

      if (read.candidate) {
        freeDurationMsOmitted += typeof read.candidate.durationMs === "number" ? 0 : 1;
        const result = await anchorTrack(trackId, [read.candidate], {
          source: "spotify-isrc",
          stampOnMiss: false,
        });

        if (result.anchored) {
          return {
            anchored: true,
            freeDurationMsOmitted,
            source: "spotify-isrc",
            spotifyIsrcAsked: true,
            spotifyIsrcCleanMiss: false,
            spotifySearchDone: true,
            spotifyThrottled: false,
            verifiedBy: result.verifiedBy,
          };
        }

        spotifyIsrcCleanMiss = true;
      }
    }
  }

  const isrcAsked = Boolean(isrc?.trim());

  let candidates: TrackSearchResult[];

  try {
    candidates = await searchTrackCandidates(anchorSearchQuery(artists, title));
  } catch (error) {
    logEvent("warn", "anchor.spotify-search-failed", { error, trackId });

    return {
      ...NO_SPOTIFY_OUTCOME,
      freeDurationMsOmitted,
      spotifyIsrcAsked: isrcAsked,
      spotifyIsrcCleanMiss,
      spotifySearchDone: true,
      spotifyThrottled: isSpotifyThrottle(error),
    };
  } finally {
    await recordAnchorSpotifyCall(now);
  }

  const anchorCandidates = candidates.map(searchResultCandidate);
  freeDurationMsOmitted += anchorCandidates.filter(
    (candidate) => typeof candidate.durationMs !== "number",
  ).length;
  const result = await anchorTrack(trackId, anchorCandidates, {
    source: "spotify-search",
    stampOnMiss: false,
  });

  return {
    anchored: result.anchored,
    freeDurationMsOmitted,
    source: result.anchored ? "spotify-search" : null,
    spotifyIsrcAsked: isrcAsked,
    spotifyIsrcCleanMiss,
    spotifySearchDone: true,
    spotifyThrottled: false,
    verifiedBy: result.verifiedBy,
  };
}

export async function recoverIsrcViaDeezer(
  trackId: string,
  db: Awaited<ReturnType<typeof getDb>>,
  rowArtists: string[],
  rowTitle: string,
  rowDurationMs: number,
  suppliedCandidates?: DeezerIsrcCandidate[],
): Promise<string | undefined> {
  if (!rowTitle.trim() || rowArtists.length === 0 || !(rowDurationMs > 0)) {
    return undefined;
  }

  const candidates =
    suppliedCandidates ?? (await searchDeezerCandidates({ artists: rowArtists, title: rowTitle }));

  if (candidates.length === 0) {
    if (suppliedCandidates !== undefined) {
      await batchDueWorkSourceMutation(
        db,
        [
          {
            args: [new Date().toISOString(), trackId],
            sql: `update tracks
                  set isrc_recovery_attempted_at = ?
                  where track_id = ?`,
          },
        ],
        [{ subjectId: trackId, subjectType: "track" }],
        { producer: "isrc-recovery-empty" },
      );
    }

    return undefined;
  }

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
    const missAt = new Date().toISOString();
    const recoveryAttemptedAt = suppliedCandidates === undefined ? null : missAt;

    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [missAt, missAt, recoveryAttemptedAt, trackId],
          sql: `update tracks
                set isrc_attempted_at = ?,
                    backfill_deezer_attempted_at = ?,
                    backfill_deezer_attempts = backfill_deezer_attempts + 1,
                    isrc_recovery_attempted_at = coalesce(?, isrc_recovery_attempted_at)
                where track_id = ?`,
        },
      ],
      [{ subjectId: trackId, subjectType: "track" }],
      { producer: "isrc-recovery-miss" },
    );

    return undefined;
  }

  const now = new Date().toISOString();
  const deezerTrackId = verified?.candidate.deezerTrackId ?? null;
  const deezerWonAt = deezerTrackId === null ? null : now;
  const recoveryAttemptedAt = suppliedCandidates === undefined ? null : now;

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [
          recovered,
          recovered,
          now,
          recoveryAttemptedAt,
          deezerTrackId,
          deezerTrackId === null ? null : (verified?.via ?? null),
          deezerWonAt,
          deezerWonAt,
          deezerTrackId === null ? 0 : 1,
          deezerWonAt,
          trackId,
        ],
        sql: `update tracks
          set ${FILL_ISRC_SQL},
              isrc_attempted_at = ?,
              isrc_recovery_attempted_at = coalesce(?, isrc_recovery_attempted_at),
              deezer_track_id = coalesce(deezer_track_id, ?),
              deezer_verified_by = coalesce(deezer_verified_by, ?),
              deezer_verified_at = coalesce(deezer_verified_at, ?),
              backfill_deezer_attempted_at = coalesce(?, backfill_deezer_attempted_at),
              backfill_deezer_attempts = backfill_deezer_attempts + ?,
              backfill_deezer_done_at = coalesce(backfill_deezer_done_at, ?)
          where track_id = ?`,
      },
      updateTrackDuplicateIsrcStatement(trackId, recovered),
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "isrc-recovery-hit" },
  );

  return recovered;
}

async function stampAnchorAttempt(
  db: Awaited<ReturnType<typeof getDb>>,
  trackId: string,
  now: Date,
  options: { chargeAttempt: boolean },
): Promise<void> {
  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [now.toISOString(), trackId],

        sql: `update tracks
              set spotify_anchor_attempted_at = ?,
                  spotify_isrc_asked_at = null
                  ${options.chargeAttempt ? ", spotify_anchor_attempts = coalesce(spotify_anchor_attempts, 0) + 1" : ""}
              where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "anchor-stamp" },
  );
}

export async function requeueAnchorStamps(trackIds: string[]): Promise<number> {
  if (trackIds.length === 0) {
    return 0;
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const source = {
    args: trackIds,
    sql: `select track_id as subject_id from tracks
          where track_id in (${placeholders})
            and spotify_uri is null
            and spotify_anchor_attempted_at is not null
            and has_isrc = 1`,
  };
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements("track", source, {
        producer: "anchor-requeue",
      }),
      {
        args: trackIds,
        sql: `update tracks
              set spotify_anchor_attempted_at = null,
                  spotify_anchor_attempts = case
                    when spotify_anchor_terminal_error is not null then 0
                    else spotify_anchor_attempts end,
                  spotify_anchor_invalid_attempts = 0,
                  spotify_anchor_terminal_error = null
              where track_id in (${placeholders})
                and spotify_uri is null
                and spotify_anchor_attempted_at is not null
                and has_isrc = 1`,
      },
    ],
    "write",
  );
  const result = results.at(-1);

  return result?.rowsAffected ?? 0;
}

const ISRC_RECOVERY_EMPTY_MISS_WHERE = `isrc_recovery_attempted_at is not null
        and isrc_recovery_attempted_at >= ?
        and isrc_attempted_at is not isrc_recovery_attempted_at
        and has_isrc = 0
        and spotify_uri is null`;

export async function requeueIsrcRecoveryStamps(input: {
  dryRun: boolean;
  since: string;
}): Promise<{ matched: number; requeued: number }> {
  const db = await getDb();
  const counted = await db.execute({
    args: [input.since],
    sql: `select count(*) as matched from tracks where ${ISRC_RECOVERY_EMPTY_MISS_WHERE}`,
  });
  const matched = Number(counted.rows[0]?.matched ?? 0);

  if (input.dryRun || matched === 0) {
    return { matched, requeued: 0 };
  }

  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "track",
        {
          args: [input.since],
          sql: `select track_id as subject_id from tracks where ${ISRC_RECOVERY_EMPTY_MISS_WHERE}`,
        },
        { producer: "isrc-recovery-requeue" },
      ),
      {
        args: [input.since],
        sql: `update tracks
              set isrc_recovery_attempted_at = null
              where ${ISRC_RECOVERY_EMPTY_MISS_WHERE}`,
      },
    ],
    "write",
  );

  return { matched, requeued: results.at(-1)?.rowsAffected ?? 0 };
}

async function stampSpotifyIsrcAsked(
  db: Awaited<ReturnType<typeof getDb>>,
  trackId: string,
  now: Date,
): Promise<void> {
  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [now.toISOString(), trackId],
        sql: `update tracks set spotify_isrc_asked_at = ? where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "anchor-isrc-asked" },
  );
}

type ApifyAdmissionInput = {
  anchored: boolean;
  apifyEnabled: boolean;

  hasIsrc: boolean;
  gateReason: AnchorSpotifyGateReason;

  priorAsk: boolean;

  spotifyIsrcCleanMiss: boolean;
  spotifySearchEnabled: boolean;

  spotifySearchSettled: boolean;
};

type ApifyAdmission = Pick<
  AnchorResolveResult,
  "apifyBudgetRemaining" | "apifyEligible" | "apifyIneligibleReason"
>;

async function admitToApifyRung(
  db: Awaited<ReturnType<typeof getDb>>,
  trackId: string,
  now: Date,
  input: ApifyAdmissionInput,
): Promise<ApifyAdmission> {
  if (input.spotifyIsrcCleanMiss) {
    await stampSpotifyIsrcAsked(db, trackId, now);
  }

  const withBudget = async (
    apifyEligible: boolean,
    apifyIneligibleReason: AnchorApifyIneligibleReason | null,
  ): Promise<ApifyAdmission> => ({
    apifyBudgetRemaining: (await getAnchorApifyBudget(now)).remainingRows,
    apifyEligible,
    apifyIneligibleReason,
  });

  if (input.anchored) {
    return withBudget(false, null);
  }

  const asked = input.hasIsrc
    ? input.priorAsk || input.spotifyIsrcCleanMiss
    : input.spotifySearchSettled;

  if (
    input.gateReason === "friday_window" ||
    (input.spotifySearchEnabled &&
      !asked &&
      !(input.hasIsrc && input.gateReason === "breaker_quota"))
  ) {
    return withBudget(false, "awaiting_free_ask");
  }

  if (!input.apifyEnabled) {
    return withBudget(true, null);
  }

  const { budget, charged } = await chargeAnchorApifyRow(now);
  if (charged) {
    await db.execute({
      args: [now.toISOString(), trackId],
      sql: "update tracks set spotify_anchor_paid_admitted_at = ? where track_id = ?",
    });
  }

  return {
    apifyBudgetRemaining: budget.remainingRows,
    apifyEligible: charged,
    apifyIneligibleReason: charged ? null : "apify_budget_spent",
  };
}

export async function resolveAnchorFree(
  trackId: string,
  now: Date = new Date(),
  options: { deezerCandidates?: DeezerIsrcCandidate[]; spotifySearch?: boolean } = {},
): Promise<AnchorResolveResult> {
  const db = await getDb();

  const apifyEnabled = await isAnchorApifyEnabled();

  const spotifySearchEnabled = await isAnchorSpotifySearchEnabled();
  const gateReason = (await anchorSpotifySearchGate(now)).reason;

  const found = await db.execute({
    args: [trackId],
    sql: `select mb_recording_id, isrc, artists_json, title, duration_ms, spotify_isrc_asked_at
          from tracks where track_id = ? limit 1`,
  });
  const row = typedRows<{
    artists_json: null | string;
    duration_ms: null | number;
    isrc: null | string;
    mb_recording_id: null | string;
    spotify_isrc_asked_at: null | string;
    title: null | string;
  }>(found.rows)[0];

  if (!row) {
    const { spotifyIsrcCleanMiss: _ignored, ...noSpotify } = NO_SPOTIFY_OUTCOME;

    return {
      ...noSpotify,
      apifyBudgetRemaining: (await getAnchorApifyBudget(now)).remainingRows,
      apifyEligible: false,
      apifyEnabled,
      apifyIneligibleReason: null,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "not-attempted",
      spotifySearchEnabled,
      stamped: false,
    };
  }

  const priorAsk = Boolean(row.spotify_isrc_asked_at);

  const rowArtists = parseArtistsJson(row.artists_json ?? "[]");

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

  const listenbrainz = await resolveViaListenBrainz(trackId, row.mb_recording_id, now);
  const listenbrainzDurationMsOmitted = listenbrainz.durationMsOmitted ?? 0;

  if (listenbrainz.outcome === "anchored") {
    const { spotifyIsrcCleanMiss: _ignored, ...noSpotify } = NO_SPOTIFY_OUTCOME;

    return {
      ...noSpotify,
      anchored: true,
      ...(await admitToApifyRung(db, trackId, now, {
        anchored: true,
        apifyEnabled,
        gateReason,
        hasIsrc: Boolean(isrc?.trim()),
        priorAsk,
        spotifyIsrcCleanMiss: false,
        spotifySearchEnabled,
        spotifySearchSettled: false,
      })),
      apifyEnabled,
      freeDurationMsOmitted: listenbrainzDurationMsOmitted,
      isrcRecoveredByDeezer,
      listenbrainzOutcome: "anchored",
      source: "listenbrainz",
      spotifySearchEnabled,
      stamped: false,
      verifiedBy: listenbrainz.verifiedBy,
    };
  }

  const callerDefers = options.spotifySearch === false;

  const listenbrainzYielded = listenbrainz.outcome === "yielded-on-breaker";

  if (callerDefers || !(await anchorSpotifySearchAllowed(now))) {
    const park = !apifyEnabled && !spotifySearchEnabled && !listenbrainzYielded;

    if (park) {
      await stampAnchorAttempt(db, trackId, now, { chargeAttempt: false });
    }

    const { spotifyIsrcCleanMiss: _ignored, ...noSpotify } = NO_SPOTIFY_OUTCOME;

    return {
      ...noSpotify,

      ...(await admitToApifyRung(db, trackId, now, {
        anchored: false,
        apifyEnabled,
        gateReason,
        hasIsrc: Boolean(isrc?.trim()),
        priorAsk,
        spotifyIsrcCleanMiss: false,
        spotifySearchEnabled,
        spotifySearchSettled: false,
      })),
      apifyEnabled,
      freeDurationMsOmitted: listenbrainzDurationMsOmitted,
      isrcRecoveredByDeezer,
      listenbrainzOutcome: listenbrainz.outcome,
      spotifySearchEnabled,

      spotifyThrottled: Boolean(listenbrainz.throttled),
      stamped: park,
    };
  }

  const searchOutcome = await resolveViaSpotifySearch(
    trackId,
    isrc,
    rowArtists,
    row.title ?? "",
    now,
  );

  const throttled = searchOutcome.spotifyThrottled || Boolean(listenbrainz.throttled);
  const settled = !apifyEnabled && !searchOutcome.anchored && !throttled;

  if (settled) {
    await stampAnchorAttempt(db, trackId, now, { chargeAttempt: true });
  }

  const { spotifyIsrcCleanMiss, ...searchWire } = searchOutcome;

  return {
    ...searchWire,

    ...(await admitToApifyRung(db, trackId, now, {
      anchored: searchOutcome.anchored,
      apifyEnabled,
      gateReason,
      hasIsrc: Boolean(isrc?.trim()),
      priorAsk,
      spotifyIsrcCleanMiss,
      spotifySearchEnabled,
      spotifySearchSettled: searchOutcome.spotifySearchDone && !throttled,
    })),
    apifyEnabled,
    freeDurationMsOmitted: listenbrainzDurationMsOmitted + searchOutcome.freeDurationMsOmitted,
    isrcRecoveredByDeezer,
    listenbrainzOutcome: listenbrainz.outcome,
    spotifySearchEnabled,
    spotifyThrottled: throttled,
    stamped: settled,
  };
}

export type AnchorReviewReason = "version_mismatch";

export type AnchorReviewSource =
  | "apify"
  | "deezer"
  | "listenbrainz"
  | "spotify-isrc"
  | "spotify-search";

export type AnchorReviewCandidate = {
  albumImageUrl?: null | string;
  artists: AnchorArtist[];
  durationMs: number;
  isrc?: null | string;
  source: AnchorReviewSource;
  spotifyTrackId?: null | string;
  title: string;
};

export type AnchorReview = {
  at: string;
  candidate: AnchorReviewCandidate;
  reason: AnchorReviewReason;

  title: string;
};

export const ANCHOR_REVIEW_QUEUE_LIMIT = 25;

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

export type AnchorReviewRow = {
  anchorAt: string;
  artUrl?: string;
  artists: string[];
  candidateArtists: string[];

  candidateDescriptor: string;

  candidateSpotifyTrackId?: string;
  candidateTitle: string;

  deltaMs: number;

  mbRecordingId?: string;
  title: string;
  trackId: string;
};

export function anchorReviewQueueStatement(): { args: number[]; sql: string } {
  return {
    args: [ANCHOR_REVIEW_QUEUE_LIMIT],
    sql: `select track_id, title, artists_json, album_image_url, duration_ms,
                 mb_recording_id, anchor_review_json
          from tracks
          where anchor_review_json is not null
            and +spotify_uri is null
            and dismissed_at is null
          order by track_id asc
          limit ?`,
  };
}

export async function listAnchorReviewRows(): Promise<AnchorReviewRow[]> {
  const db = await getDb();
  const result = await db.execute(anchorReviewQueueStatement());

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

export type AnchorReviewResolution = "accepted" | "dismissed";

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

  const candidateIsrc = review.candidate.isrc?.trim() ? review.candidate.isrc.trim() : null;
  const expectedIsrc = row.isrc ?? candidateIsrc;

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [
          `spotify:track:${spotifyId}`,
          `https://open.spotify.com/track/${spotifyId}`,
          review.candidate.albumImageUrl ?? null,

          candidateIsrc,
          candidateIsrc,
          now.toISOString(),

          now.toISOString(),
          trackId,
        ],
        sql: `update tracks
          set spotify_uri = ?,
              spotify_url = ?,
              album_image_url = coalesce(album_image_url, ?),
              ${FILL_ISRC_SQL},
              spotify_anchor_attempted_at = ?,
              spotify_anchor_attempts = coalesce(spotify_anchor_attempts, 0) + 1,
              spotify_anchor_source = null,
              spotify_anchor_verified_by = 'operator',
              spotify_anchored_at = ?,
              anchor_review_json = null,
              -- The free exact-ISRC ask receipt dies with the question it was evidence about
              -- (schema.ts, spotify_isrc_asked_at): this row is anchored, so there is nothing
              -- left to ask and nothing left to authorise.
              spotify_isrc_asked_at = null
          where track_id = ?`,
      },
      updateTrackDuplicateIsrcStatement(trackId, expectedIsrc),
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "anchor-review-accept" },
  );

  await connectAnchorArtists(
    trackId,
    review.candidate.artists.map((artist) => artist.name),
    review.candidate.artists.map((artist) => artist.id ?? ""),
  );

  logEvent("info", "anchor.review-accepted", { spotifyId, trackId });

  return { anchored: true, review };
}
