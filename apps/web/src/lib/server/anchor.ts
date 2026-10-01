import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ReleaseLinkProbeSchema } from "@fluncle/contracts/orpc";

import {
  ANCHOR_APIFY_REFUND_ACTION,
  ANCHOR_APIFY_REFUND_DAILY_ROWS,
  ANCHOR_APIFY_SPEND_ACTION,
  ANCHOR_APIFY_SPEND_BUCKET,
  chargeAnchorApifyRowForTrack,
  getAnchorApifyBudget,
  hasUnsettledAnchorPaidReceipt,
  isAnchorApifyEnabled,
} from "./anchor-apify";
import {
  ANCHOR_QUOTA_EXCEPTION_START_HOUR_UTC,
  anchorSpotifyBreakerAllows,
  anchorSpotifySearchAllowed,
  anchorSpotifySearchGate,
  type AnchorSpotifyGateReason,
  isAnchorSpotifySearchEnabled,
} from "./anchor-spotify-search";
import { parseArtistsJson, stampRemixerRoles, upsertTrackArtists } from "./artists";
import { getDb, typedRows } from "./db";
import {
  batchDueWorkSourceMutation,
  markDueWorkSourceMaintenanceFromSelectStatements,
} from "./due-work";
import { type DeezerIsrcCandidate, searchDeezerCandidates } from "./deezer";
import { readEnv } from "./env";
import { FILL_ISRC_SQL } from "./isrc";
import { lookupSpotifyIdsByMbid, lookupSpotifyIdsByMetadata } from "./listenbrainz";
import { logEvent } from "./log";
import {
  commitReleaseLinks,
  emptyReleaseLinkResult,
  isEligibleReleaseSibling,
  probeReleaseLinks,
  resolveReleaseLinks,
  type ReleaseLinkProbe,
  type ReleaseLinkResult,
} from "./anchor-release-links";
import { updateTrackDuplicateIsrcStatement } from "./track-duplicate-keys";
import { ANCHOR_MAX_ATTEMPTS } from "./track-work";
import {
  fetchTrackMetadata,
  findSpotifyTrackByIsrc,
  searchTrackCandidates,
  type SpotifyAlbumTrack,
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
  spotify_anchor_attempted_at: null | string;
  spotify_anchor_paid_admitted_at: null | string;
  spotify_anchor_paid_state: null | string;
  spotify_anchor_source: null | string;
  spotify_anchor_verified_by: null | string;
  spotify_isrc_asked_at: null | string;
  spotify_uri: null | string;
  title: string;
};

export type AnchorApifyIneligibleReason =
  | "apify_budget_spent"
  | "awaiting_free_ask"
  | "awaiting_paid_result";

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

async function verifyPaidAnchorResultToken(
  row: AnchorRow,
  trackId: string,
  paidResultToken: string,
): Promise<boolean> {
  const result = await verifyAnchorPhase<AnchorPaidResultToken>(paidResultToken, "paid-result");
  if (result.trackId !== trackId || result.receiptAt !== row.spotify_anchor_paid_admitted_at) {
    throw new AnchorTrackError(
      "awaiting_free_ask",
      `Track ${trackId} has no matching paid receipt`,
    );
  }
  return !hasUnsettledAnchorPaidReceipt(
    row.spotify_anchor_paid_admitted_at,
    row.spotify_anchor_paid_state,
  );
}

async function assertPaidAnchorAdmission(
  row: AnchorRow,
  trackId: string,
  source: AnchorReviewSource,
  paidResultToken?: string,
): Promise<void> {
  if (source !== "apify") {
    return;
  }
  if (paidResultToken) {
    if (await verifyPaidAnchorResultToken(row, trackId, paidResultToken)) {
      throw new AnchorTrackError("awaiting_free_ask", `Track ${trackId} has a settled paid result`);
    }
    return;
  }
  const now = new Date();
  const paidAdmittedAt = Date.parse(row.spotify_anchor_paid_admitted_at ?? "");
  const paidAdmissionLive =
    Number.isFinite(paidAdmittedAt) &&
    now.getTime() >= paidAdmittedAt &&
    now.getTime() - paidAdmittedAt <= ANCHOR_PAID_ADMISSION_MAX_AGE_MS;
  if (paidAdmissionLive) {
    return;
  }
  const gateReason = (await anchorSpotifySearchGate(now)).reason;
  if (gateReason === "friday_window") {
    throw new AnchorTrackError("awaiting_free_ask", `Track ${trackId} waits for the Friday window`);
  }
  if (
    row.isrc?.trim() &&
    !row.spotify_isrc_asked_at &&
    (await isAnchorSpotifySearchEnabled()) &&
    gateReason !== "breaker_quota" &&
    !(gateReason === "daily_budget" && now.getUTCHours() >= ANCHOR_QUOTA_EXCEPTION_START_HOUR_UTC)
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

// oxlint-disable-next-line complexity
export async function anchorTrack(
  trackId: string,
  candidates: AnchorCandidate[],
  options: {
    paidResultToken?: string;
    skipVersionReview?: boolean;
    source?: AnchorReviewSource;
    stampOnMiss?: boolean;
  } = {},
): Promise<{ anchored: boolean; verifiedBy: AnchorGateVerification }> {
  const { source = "apify", stampOnMiss = true } = options;
  const db = await getDb();

  const found = await db.execute({
    args: [trackId],
    sql: `select t.isrc, t.title, t.artists_json, t.duration_ms, t.spotify_uri,
                 t.spotify_anchor_attempted_at,
                 t.spotify_isrc_asked_at, t.spotify_anchor_paid_admitted_at,
                 t.spotify_anchor_paid_state, t.spotify_anchor_source,
                 t.spotify_anchor_verified_by,
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

  if (options.paidResultToken && source !== "apify") {
    throw new AnchorTrackError("awaiting_free_ask", `Track ${trackId} has an invalid paid source`);
  }
  const paidResultSettled = options.paidResultToken
    ? await verifyPaidAnchorResultToken(row, trackId, options.paidResultToken)
    : false;

  if (row.spotify_uri) {
    const matchingCandidate = candidates.find(
      (candidate) => row.spotify_uri === `spotify:track:${candidate.spotifyTrackId}`,
    );
    if (paidResultSettled && row.spotify_anchor_source === "apify" && matchingCandidate) {
      await connectAnchorArtists(
        trackId,
        matchingCandidate.artists.map((artist) => artist.name),
        matchingCandidate.artists.map((artist) => artist.id ?? ""),
      );
      const verifiedBy = row.spotify_anchor_verified_by;
      return {
        anchored: true,
        verifiedBy:
          verifiedBy === "isrc" || verifiedBy === "search" || verifiedBy === "search-subset"
            ? verifiedBy
            : null,
      };
    }
    throw new AnchorTrackError(
      "already_anchored",
      `Track ${trackId} already carries a Spotify anchor`,
    );
  }

  if (paidResultSettled) {
    return { anchored: false, verifiedBy: null };
  }

  await assertPaidAnchorAdmission(row, trackId, source, options.paidResultToken);

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
  const paidSettlementState =
    source === "apify" &&
    hasUnsettledAnchorPaidReceipt(
      row.spotify_anchor_paid_admitted_at,
      row.spotify_anchor_paid_state,
    )
      ? "settled"
      : null;

  if (!verified) {
    const suspect = options.skipVersionReview
      ? null
      : detectVersionMismatch(
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
            args: [now, paidSettlementState, trackId],

            sql: `update tracks
                  set spotify_anchor_attempted_at = ?,
                      spotify_anchor_paid_state = coalesce(?, spotify_anchor_paid_state),
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
          paidSettlementState,
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
              spotify_anchor_paid_state = coalesce(?, spotify_anchor_paid_state),
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

export type AnchorResolveSource =
  | "listenbrainz"
  | "listenbrainz-metadata"
  | "release-link"
  | "spotify-isrc"
  | "spotify-search";

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
  anchoredByReleaseLink?: number;
  releaseLinkAlbumsFetched?: number;
  releaseLinkCacheHits?: number;
  releaseLinkNoAlbum?: number;
  releaseLinkBackoffSkipped?: number;
  releaseLinkAlbumFetchFailed?: number;
  paidResultToken?: string;
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

async function anchorReleaseSibling(
  siblingId: string,
  tracks: SpotifyAlbumTrack[],
): Promise<boolean> {
  if (!(await isEligibleReleaseSibling(siblingId))) {
    return false;
  }
  const candidates = tracks.map(
    (track: SpotifyAlbumTrack): AnchorCandidate => ({
      artists: track.artists,
      durationMs: track.durationMs,
      isrc: track.isrc,
      spotifyTrackId: track.spotifyTrackId,
      title: track.title,
    }),
  );
  try {
    return (
      await anchorTrack(siblingId, candidates, {
        skipVersionReview: true,
        source: "release-link",
        stampOnMiss: false,
      })
    ).anchored;
  } catch (error) {
    if (error instanceof AnchorTrackError) {
      return false;
    }
    throw error;
  }
}

export async function resolveReleaseLinkForTrack(
  trackId: string,
  recordingMbid: null | string,
  now: Date,
  spotifyAllowed: boolean,
): Promise<ReleaseLinkResult> {
  return resolveReleaseLinks(trackId, recordingMbid, now, spotifyAllowed, anchorReleaseSibling);
}

export async function probeAnchorReleaseLink(
  trackId: string,
  now: Date = new Date(),
  spotifyAllowed = true,
): Promise<ReleaseLinkProbe> {
  const db = await getDb();
  const found = await db.execute({
    args: [trackId],
    sql: "select mb_recording_id from tracks where track_id = ? limit 1",
  });
  const row = typedRows<{ mb_recording_id: null | string }>(found.rows)[0];
  if (!row) {
    throw new AnchorTrackError("not_found", `No track with id ${trackId}`);
  }
  return probeReleaseLinks(trackId, row.mb_recording_id, now, spotifyAllowed);
}

export async function signAnchorReleaseProbe(probe: ReleaseLinkProbe): Promise<string> {
  const parsed = ReleaseLinkProbeSchema.parse(probe);
  return createHmac("sha256", await anchorPhaseKey())
    .update("anchor-release:v1")
    .update(canonicalReleaseJson(parsed))
    .digest("base64url");
}

function canonicalReleaseJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalReleaseJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalReleaseJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function commitAnchorReleaseLink(
  probe: ReleaseLinkProbe,
  proof: string,
  cursor: number,
): Promise<ReleaseLinkResult> {
  const expected = await signAnchorReleaseProbe(probe);
  const actualBytes = Buffer.from(proof);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes) ||
    !Number.isSafeInteger(probe.issuedAt) ||
    probe.issuedAt > Date.now() ||
    Date.now() - probe.issuedAt > 30 * 60 * 1000
  ) {
    throw new Error("invalid or expired release probe");
  }
  return commitReleaseLinks(probe, anchorReleaseSibling, cursor);
}

function releaseLinkFields(result: ReleaseLinkResult) {
  return {
    ...(result.anchoredCount > 0 ? { anchoredByReleaseLink: result.anchoredCount } : {}),
    ...(result.albumsFetched > 0 ? { releaseLinkAlbumsFetched: result.albumsFetched } : {}),
    ...(result.cacheHits > 0 ? { releaseLinkCacheHits: result.cacheHits } : {}),
    ...(result.noAlbum > 0 ? { releaseLinkNoAlbum: result.noAlbum } : {}),
    ...(result.backoffSkipped > 0 ? { releaseLinkBackoffSkipped: result.backoffSkipped } : {}),
    ...(result.albumFetchFailed > 0
      ? { releaseLinkAlbumFetchFailed: result.albumFetchFailed }
      : {}),
  };
}

export async function resolveAnchorReleaseLink(
  trackId: string,
  now: Date = new Date(),
  spotifyAllowed = true,
): Promise<ReleaseLinkResult> {
  const db = await getDb();
  const found = await db.execute({
    args: [trackId],
    sql: "select mb_recording_id from tracks where track_id = ? limit 1",
  });
  const row = typedRows<{ mb_recording_id: null | string }>(found.rows)[0];
  if (!row) {
    throw new AnchorTrackError("not_found", `No track with id ${trackId}`);
  }
  return resolveReleaseLinkForTrack(trackId, row.mb_recording_id, now, spotifyAllowed);
}

function isSpotifyThrottle(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("429") || error.name === "SpotifyDeferredError")
  );
}

async function metadataCandidate(
  spotifyTrackId: string,
  _now: Date,
): Promise<{ candidate: AnchorCandidate | undefined; throttled: boolean }> {
  try {
    const metadata = await fetchTrackMetadata(spotifyTrackId, "anchor");

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
  }
}

type ListenBrainzResolveResult = {
  durationMsOmitted?: number;
  source?: "listenbrainz" | "listenbrainz-metadata";
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
  artistName: string,
  releaseName: string,
  trackName: string,
  now: Date,
): Promise<ListenBrainzResolveResult> {
  let lookup = mbid?.trim() ? await lookupSpotifyIdsByMbid(mbid) : { outcome: "no-map" as const };
  let source: "listenbrainz" | "listenbrainz-metadata" = "listenbrainz";
  if (lookup.outcome === "no-map" || lookup.outcome === "empty-ids") {
    const metadata = await lookupSpotifyIdsByMetadata(artistName, releaseName, trackName);
    if (metadata.outcome === "match") {
      lookup = metadata;
      source = "listenbrainz-metadata";
    }
  }

  if (lookup.outcome !== "match") {
    if (lookup.outcome === "no-map") {
      return { outcome: mbid?.trim() ? "no-map" : "no-mbid" };
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
    source,
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
    source,
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
    candidates = await searchTrackCandidates(anchorSearchQuery(artists, title), "anchor");
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
  phaseNow: Date | string = new Date(),
): Promise<string | undefined> {
  const phaseAt = typeof phaseNow === "string" ? phaseNow : phaseNow.toISOString();
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
            args: [phaseAt, trackId],
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
    const missAt = phaseAt;
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

  const now = phaseAt;
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
  now: Date | string,
  options: { chargeAttempt: boolean },
): Promise<void> {
  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [typeof now === "string" ? now : now.toISOString(), trackId],

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

export async function clearPendingAnchorPaidReceipts(trackIds: string[]): Promise<number> {
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
            and spotify_anchor_paid_state = 'pending'`,
  };
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements("track", source, {
        producer: "anchor-requeue",
      }),
      {
        args: trackIds,
        sql: `update tracks
              set spotify_anchor_paid_state = 'settled',
                  spotify_anchor_attempted_at = null,
                  spotify_anchor_attempts = case
                    when spotify_anchor_terminal_error is not null then 0
                    else spotify_anchor_attempts end,
                  spotify_anchor_invalid_attempts = 0,
                  spotify_anchor_terminal_error = null
              where track_id in (${placeholders})
                and spotify_uri is null
                and spotify_anchor_paid_state = 'pending'`,
      },
    ],
    "write",
  );
  return results.at(-1)?.rowsAffected ?? 0;
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
  now: Date | string,
): Promise<void> {
  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [typeof now === "string" ? now : now.toISOString(), trackId],
        sql: `update tracks set spotify_isrc_asked_at = ? where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "anchor-isrc-asked" },
  );
}

type ApifyAdmissionInput = {
  allowPaid?: boolean;
  anchored: boolean;
  apifyEnabled: boolean;

  hasIsrc: boolean;
  gateReason: AnchorSpotifyGateReason;

  priorAsk: boolean;

  receiptAt?: string;

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
    await stampSpotifyIsrcAsked(db, trackId, input.receiptAt ?? now);
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

  const existing = await db.execute({
    args: [trackId],
    sql: `select spotify_anchor_paid_admitted_at as receipt,
                 spotify_anchor_paid_state as paid_state
          from tracks where track_id = ? limit 1`,
  });
  const previous = existing.rows[0]?.receipt;
  const previousMs = Date.parse(typeof previous === "string" ? previous : "");
  const pending = hasUnsettledAnchorPaidReceipt(previous, existing.rows[0]?.paid_state, now);
  if (
    input.receiptAt &&
    previous === input.receiptAt &&
    pending &&
    Number.isFinite(previousMs) &&
    previousMs <= now.getTime() &&
    now.getTime() - previousMs <= ANCHOR_PAID_ADMISSION_MAX_AGE_MS
  ) {
    return withBudget(true, null);
  }
  if (input.allowPaid === false) {
    return withBudget(false, null);
  }
  if (pending || (input.receiptAt && previous === input.receiptAt)) {
    return withBudget(false, "awaiting_paid_result");
  }

  const asked = input.hasIsrc
    ? input.priorAsk || input.spotifyIsrcCleanMiss
    : input.spotifySearchSettled;

  if (
    input.gateReason === "friday_window" ||
    (input.spotifySearchEnabled &&
      !asked &&
      !(
        input.hasIsrc &&
        (input.gateReason === "breaker_quota" ||
          (input.gateReason === "daily_budget" &&
            now.getUTCHours() >= ANCHOR_QUOTA_EXCEPTION_START_HOUR_UTC))
      ))
  ) {
    return withBudget(false, "awaiting_free_ask");
  }

  if (!input.apifyEnabled) {
    return withBudget(true, null);
  }

  const { budget, charged, priorReceiptLive } = await chargeAnchorApifyRowForTrack(
    trackId,
    input.receiptAt ?? newAnchorAdmissionReceipt(now),
    now,
  );

  return {
    apifyBudgetRemaining: budget.remainingRows,
    apifyEligible: charged,
    apifyIneligibleReason: charged
      ? null
      : priorReceiptLive
        ? "awaiting_paid_result"
        : "apify_budget_spent",
  };
}

// oxlint-disable-next-line complexity
export async function resolveAnchorFree(
  trackId: string,
  now: Date = new Date(),
  options: {
    allowPaid?: boolean;
    deezerCandidates?: DeezerIsrcCandidate[];
    spotifySearch?: boolean;
  } = {},
): Promise<AnchorResolveResult> {
  const db = await getDb();

  const apifyEnabled = await isAnchorApifyEnabled();

  const spotifySearchEnabled = await isAnchorSpotifySearchEnabled();
  const gateReason = (await anchorSpotifySearchGate(now)).reason;

  const found = await db.execute({
    args: [trackId],
    sql: `select mb_recording_id, isrc, artists_json, album, title, duration_ms, spotify_isrc_asked_at
          from tracks where track_id = ? limit 1`,
  });
  const row = typedRows<{
    album: null | string;
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

  const releaseLink = await resolveReleaseLinkForTrack(
    trackId,
    row.mb_recording_id,
    now,
    options.spotifySearch !== false,
  ).catch((error: unknown) => {
    logEvent("warn", "anchor.release-rung-failed", { error, trackId });
    return emptyReleaseLinkResult();
  });
  if (releaseLink.anchored) {
    const { spotifyIsrcCleanMiss: _ignored, ...noSpotify } = NO_SPOTIFY_OUTCOME;
    return {
      ...noSpotify,
      ...releaseLinkFields(releaseLink),
      anchored: true,
      ...(await admitToApifyRung(db, trackId, now, {
        allowPaid: options.allowPaid,
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
      isrcRecoveredByDeezer,
      listenbrainzOutcome: "not-attempted",
      source: "release-link",
      spotifySearchEnabled,
      stamped: false,
      verifiedBy: releaseLink.verifiedBy,
    };
  }
  const listenbrainz = await resolveViaListenBrainz(
    trackId,
    row.mb_recording_id,
    rowArtists[0] ?? "",
    row.album ?? "",
    row.title ?? "",
    now,
  );
  const listenbrainzDurationMsOmitted = listenbrainz.durationMsOmitted ?? 0;

  if (listenbrainz.outcome === "anchored") {
    const { spotifyIsrcCleanMiss: _ignored, ...noSpotify } = NO_SPOTIFY_OUTCOME;

    return {
      ...noSpotify,
      ...releaseLinkFields(releaseLink),
      anchored: true,
      ...(await admitToApifyRung(db, trackId, now, {
        allowPaid: options.allowPaid,
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
      source: listenbrainz.source ?? "listenbrainz",
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
      ...releaseLinkFields(releaseLink),

      ...(await admitToApifyRung(db, trackId, now, {
        allowPaid: options.allowPaid,
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
    ...releaseLinkFields(releaseLink),

    ...(await admitToApifyRung(db, trackId, now, {
      allowPaid: options.allowPaid,
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

const ANCHOR_PHASE_TOKEN_MAX_BYTES = 32 * 1024;
const ANCHOR_PHASE_MAX_AGE_MS = ANCHOR_PAID_ADMISSION_MAX_AGE_MS;
const ANCHOR_PAID_RESULT_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function newAnchorAdmissionReceipt(now: Date): string {
  return now
    .toISOString()
    .replace(/Z$/, `${String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0")}Z`);
}

type AnchorPhaseRow = {
  album: null | string;
  artists_json: null | string;
  certified: number;
  duration_ms: null | number;
  isrc: null | string;
  isrc_recovery_attempted_at: null | string;
  mb_recording_id: null | string;
  spotify_anchor_attempted_at: null | string;
  spotify_anchor_paid_admitted_at: null | string;
  spotify_anchor_paid_state: null | string;
  spotify_anchor_source: null | string;
  spotify_anchor_verified_by: null | string;
  spotify_isrc_asked_at: null | string;
  spotify_uri: null | string;
  title: null | string;
};

type AnchorPreparedPhase = {
  apifyEnabled: boolean;
  deezerCandidates: DeezerIsrcCandidate[] | null;
  effectiveIsrc: null | string;
  issuedAt: number;
  missing: boolean;
  receiptAt: string;
  row: AnchorPhaseRow;
  stage: "prepared";
  trackId: string;
};

type AnchorProbeEvidence = {
  attempts: { candidates: AnchorCandidate[]; source: AnchorResolveSource }[];
  candidate: AnchorCandidate | null;
  freeDurationMsOmitted: number;
  issuedAt: number;
  listenbrainzOutcome: ListenBrainzAnchorOutcome;
  preparedDigest: string;
  source: AnchorResolveSource | null;
  spotifyIsrcAsked: boolean;
  spotifyIsrcCleanMiss: boolean;
  spotifySearchDone: boolean;
  spotifyThrottled: boolean;
  stage: "probed";
};

type AnchorPaidResultToken = {
  issuedAt: number;
  receiptAt: string;
  stage: "paid-result";
  trackId: string;
};

async function anchorPhaseKey(): Promise<Buffer> {
  return createHmac("sha256", await readEnv("ADMIN_SESSION_SECRET"))
    .update("anchor-phase:v1")
    .digest();
}

async function signAnchorPhase(
  value: AnchorPaidResultToken | AnchorPreparedPhase | AnchorProbeEvidence,
): Promise<string> {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", await anchorPhaseKey())
    .update(body)
    .digest("base64url");
  const token = `${body}.${signature}`;
  if (Buffer.byteLength(token) > ANCHOR_PHASE_TOKEN_MAX_BYTES) {
    throw new Error("anchor phase token exceeds its size limit");
  }
  return token;
}

async function verifyAnchorPhase<
  T extends AnchorPaidResultToken | AnchorPreparedPhase | AnchorProbeEvidence,
>(token: string, stage: T["stage"]): Promise<T> {
  if (Buffer.byteLength(token) > ANCHOR_PHASE_TOKEN_MAX_BYTES) {
    throw new Error("invalid anchor phase token");
  }
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new Error("invalid anchor phase token");
  }
  const expected = createHmac("sha256", await anchorPhaseKey())
    .update(body)
    .digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error("invalid anchor phase token");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid anchor phase token");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !("stage" in value) ||
    value.stage !== stage ||
    !("issuedAt" in value) ||
    typeof value.issuedAt !== "number" ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt > Date.now() ||
    Date.now() - value.issuedAt >
      (stage === "paid-result" ? ANCHOR_PAID_RESULT_TOKEN_MAX_AGE_MS : ANCHOR_PHASE_MAX_AGE_MS)
  ) {
    throw new Error("invalid or expired anchor phase token");
  }
  return value as T;
}

async function readAnchorPhaseRow(trackId: string): Promise<AnchorPhaseRow> {
  const db = await getDb();
  const found = await db.execute({
    args: [trackId],
    sql: `select t.album, t.artists_json, t.duration_ms, t.isrc, t.isrc_recovery_attempted_at,
                 t.mb_recording_id,
                 t.spotify_anchor_attempted_at, t.spotify_anchor_paid_admitted_at,
                 t.spotify_anchor_paid_state,
                 t.spotify_anchor_source, t.spotify_anchor_verified_by,
                 t.spotify_isrc_asked_at, t.spotify_uri, t.title,
                 (f.track_id is not null) as certified
          from tracks t left join findings f on f.track_id = t.track_id
          where t.track_id = ? limit 1`,
  });
  const row = typedRows<AnchorPhaseRow>(found.rows)[0];
  if (!row) {
    throw new AnchorTrackError("not_found", `No track with id ${trackId}`);
  }
  return row;
}

function verifiedAnchorPhaseCandidate(
  row: AnchorPhaseRow,
  effectiveIsrc: null | string,
  candidate: AnchorCandidate,
): boolean {
  if (effectiveIsrc && pickIsrcCandidate(effectiveIsrc, Number(row.duration_ms), [candidate])) {
    return true;
  }
  return Boolean(
    verifySearchCandidate(
      parseArtistsJson(row.artists_json ?? "[]"),
      row.title ?? "",
      Number(row.duration_ms),
      [
        {
          artists: candidate.artists.map((artist) => artist.name),
          durationMs: candidate.durationMs,
          title: candidate.title,
        },
      ],
    ),
  );
}

function pickAnchorPhaseCandidate(
  row: AnchorPhaseRow,
  effectiveIsrc: null | string,
  candidates: AnchorCandidate[],
): AnchorCandidate | undefined {
  const byIsrc = effectiveIsrc
    ? pickIsrcCandidate(effectiveIsrc, Number(row.duration_ms), candidates)
    : undefined;
  if (byIsrc) {
    return byIsrc;
  }
  return verifySearchCandidate(
    parseArtistsJson(row.artists_json ?? "[]"),
    row.title ?? "",
    Number(row.duration_ms),
    candidates.map((candidate) => ({
      artists: candidate.artists.map((artist) => artist.name),
      candidate,
      durationMs: candidate.durationMs,
      title: candidate.title,
    })),
  )?.candidate.candidate;
}

export async function prepareAnchorFreePhase(
  trackId: string,
  deezerCandidates?: DeezerIsrcCandidate[],
): Promise<string> {
  let row: AnchorPhaseRow;
  let missing = false;
  try {
    row = await readAnchorPhaseRow(trackId);
  } catch (error) {
    if (!(error instanceof AnchorTrackError) || error.reason !== "not_found") {
      throw error;
    }
    missing = true;
    row = {
      album: null,
      artists_json: null,
      certified: 0,
      duration_ms: null,
      isrc: null,
      isrc_recovery_attempted_at: null,
      mb_recording_id: null,
      spotify_anchor_attempted_at: null,
      spotify_anchor_paid_admitted_at: null,
      spotify_anchor_paid_state: null,
      spotify_anchor_source: null,
      spotify_anchor_verified_by: null,
      spotify_isrc_asked_at: null,
      spotify_uri: null,
      title: null,
    };
  }
  if (Number(row.certified) === 1) {
    throw new AnchorTrackError("certified", `Track ${trackId} is certified`);
  }
  if (row.spotify_uri) {
    throw new AnchorTrackError("already_anchored", `Track ${trackId} is already anchored`);
  }
  const artists = parseArtistsJson(row.artists_json ?? "[]");
  const recovered =
    !missing && !row.isrc?.trim() && deezerCandidates
      ? verifySearchCandidate(
          artists,
          row.title ?? "",
          Number(row.duration_ms),
          deezerCandidates.map((candidate) => ({
            artists: [candidate.artistName],
            durationMs: candidate.durationMs,
            isrc: candidate.isrc,
            title: candidate.title,
          })),
        )?.candidate.isrc.trim()
      : undefined;
  return signAnchorPhase({
    apifyEnabled: await isAnchorApifyEnabled(),
    deezerCandidates: deezerCandidates ?? null,
    effectiveIsrc: row.isrc?.trim() || recovered || null,
    issuedAt: Date.now(),
    missing,
    receiptAt: newAnchorAdmissionReceipt(new Date()),
    row,
    stage: "prepared",
    trackId,
  });
}

export async function readAnchorPreparedCoordinates(
  prepared: string,
): Promise<{ receiptAt: string; trackId: string }> {
  const plan = await verifyAnchorPhase<AnchorPreparedPhase>(prepared, "prepared");
  return { receiptAt: plan.receiptAt, trackId: plan.trackId };
}

export async function readAnchorPaidReceiptStatus(
  trackId: string,
  receiptAt: string,
): Promise<{ admitted: boolean; paidState: null | string }> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId, receiptAt],
    sql: `select spotify_anchor_paid_state as paid_state
          from tracks where track_id = ? and spotify_anchor_paid_admitted_at = ? limit 1`,
  });
  const row = result.rows[0];
  return {
    admitted: Boolean(row),
    paidState: typeof row?.paid_state === "string" ? row.paid_state : null,
  };
}

export async function getAnchorPaidResultToken(
  trackId: string,
  receiptAt: string,
): Promise<string> {
  const db = await getDb();
  const pending = await db.execute({
    args: [trackId, receiptAt],
    sql: `select 1 as pending from tracks
          where track_id = ? and spotify_anchor_paid_admitted_at = ?
            and spotify_anchor_paid_state = 'pending' and spotify_uri is null limit 1`,
  });
  if (pending.rows.length !== 1) {
    throw new AnchorTrackError("awaiting_free_ask", "No matching pending paid receipt");
  }
  return signAnchorPhase({
    issuedAt: Date.now(),
    receiptAt,
    stage: "paid-result",
    trackId,
  });
}

export async function cancelAnchorPaidResult(
  trackId: string,
  paidResultToken: string,
  refundCap = false,
): Promise<{ settled: true }> {
  let token: AnchorPaidResultToken;
  try {
    token = await verifyAnchorPhase<AnchorPaidResultToken>(paidResultToken, "paid-result");
  } catch {
    throw new AnchorTrackError("awaiting_free_ask", "Invalid or expired paid result token");
  }
  if (token.trackId !== trackId) {
    throw new AnchorTrackError("awaiting_free_ask", "Paid result token does not match track");
  }
  const db = await getDb();
  const source = {
    args: [trackId, token.receiptAt],
    sql: `select track_id as subject_id from tracks
          where track_id = ? and spotify_anchor_paid_admitted_at = ?
            and spotify_anchor_paid_state = 'pending' and spotify_uri is null`,
  };
  const transaction = await db.transaction("write");
  let settled = false;
  try {
    const pending = await transaction.execute({
      args: [trackId, token.receiptAt],
      sql: `select spotify_anchor_paid_charged_at as charged_at from tracks
            where track_id = ? and spotify_anchor_paid_admitted_at = ?
              and spotify_anchor_paid_state = 'pending' and spotify_uri is null limit 1`,
    });
    if (pending.rows.length === 0) {
      await transaction.rollback();
    } else {
      const chargedAt = pending.rows[0]?.charged_at;
      if (refundCap && typeof chargedAt === "string" && !Number.isNaN(Date.parse(chargedAt))) {
        const windowStart = `${chargedAt.slice(0, 10)}T00:00:00.000Z`;
        const refund = await transaction.execute({
          args: [
            ANCHOR_APIFY_REFUND_ACTION,
            ANCHOR_APIFY_SPEND_BUCKET,
            windowStart,
            ANCHOR_APIFY_SPEND_ACTION,
            ANCHOR_APIFY_SPEND_BUCKET,
            windowStart,
            ANCHOR_APIFY_REFUND_DAILY_ROWS,
          ],
          sql: `insert into rate_limit_counters (action, bucket, window_start, count)
                select ?, ?, ?, 1 where exists (
                  select 1 from rate_limit_counters
                  where action = ? and bucket = ? and window_start = ? and count > 0
                )
                on conflict(action, bucket, window_start) do update set count = count + 1
                where count < ? returning count`,
        });
        if (refund.rows.length === 1) {
          const credited = await transaction.execute({
            args: [ANCHOR_APIFY_SPEND_ACTION, ANCHOR_APIFY_SPEND_BUCKET, windowStart],
            sql: `update rate_limit_counters set count = count - 1
                  where action = ? and bucket = ? and window_start = ? and count > 0`,
          });
          if (credited.rowsAffected !== 1) {
            throw new Error("Anchor paid refund lost its spend counter");
          }
        }
      }
      const results = await transaction.batch([
        ...markDueWorkSourceMaintenanceFromSelectStatements("track", source, {
          producer: "anchor-requeue",
        }),
        {
          args: [new Date().toISOString(), trackId, token.receiptAt],
          sql: `update tracks set spotify_anchor_paid_state = 'settled',
                               spotify_anchor_attempted_at = ?,
                               spotify_anchor_attempts = case
                                 when spotify_anchor_terminal_error is not null then spotify_anchor_attempts
                                 else coalesce(spotify_anchor_attempts, 0) + 1 end,
                               spotify_isrc_asked_at = null
              where track_id = ? and spotify_anchor_paid_admitted_at = ?
                and spotify_anchor_paid_state = 'pending' and spotify_uri is null`,
        },
      ]);
      if (results.at(-1)?.rowsAffected !== 1) {
        throw new Error("Anchor paid receipt changed during cancellation");
      }
      await transaction.commit();
      settled = true;
    }
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
  if (settled) {
    return { settled: true };
  }
  const current = await readAnchorPaidReceiptStatus(trackId, token.receiptAt);
  if (current.admitted && current.paidState === "settled") {
    return { settled: true };
  }
  throw new AnchorTrackError("awaiting_free_ask", "No matching pending paid receipt");
}

export async function resolveUnavailableAnchorPaidReceipt(
  trackId: string,
  receiptAt: string,
): Promise<{ reason: "missing" | "settled" | "unavailable" }> {
  const db = await getDb();
  const terminalWhere = `track_id = ? and spotify_anchor_paid_admitted_at = ?
    and spotify_anchor_paid_state = 'pending'
    and (spotify_uri is not null or exists
      (select 1 from findings where findings.track_id = tracks.track_id))`;
  const source = {
    args: [trackId, receiptAt],
    sql: `select track_id as subject_id from tracks where ${terminalWhere}`,
  };
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements("track", source, {
        producer: "anchor-requeue",
      }),
      {
        args: [trackId, receiptAt],
        sql: `update tracks set spotify_anchor_paid_state = 'settled' where ${terminalWhere}`,
      },
    ],
    "write",
  );
  if ((results.at(-1)?.rowsAffected ?? 0) === 1) {
    return { reason: "unavailable" };
  }
  const current = await db.execute({
    args: [trackId],
    sql: `select spotify_anchor_paid_admitted_at as receipt,
                 spotify_anchor_paid_state as paid_state
          from tracks where track_id = ? limit 1`,
  });
  const row = current.rows[0];
  if (!row) {
    return { reason: "missing" };
  }
  if (row.receipt === receiptAt && row.paid_state === "settled") {
    return { reason: "settled" };
  }
  throw new AnchorTrackError("awaiting_free_ask", "No matching unavailable paid receipt");
}

type AnchorListenBrainzProbe = {
  candidate: AnchorCandidate | null;
  candidates: AnchorCandidate[];
  durationMsOmitted: number;
  outcome: ListenBrainzAnchorOutcome;
  source: "listenbrainz" | "listenbrainz-metadata";
  throttled: boolean;
};

async function probeListenBrainzPhase(
  plan: AnchorPreparedPhase,
  now: Date,
): Promise<AnchorListenBrainzProbe> {
  const mbid = plan.row.mb_recording_id;
  if (!mbid?.trim()) {
    return {
      candidate: null,
      candidates: [],
      durationMsOmitted: 0,
      outcome: "no-mbid",
      source: "listenbrainz",
      throttled: false,
    };
  }
  let lookup = await lookupSpotifyIdsByMbid(mbid);
  let source: "listenbrainz" | "listenbrainz-metadata" = "listenbrainz";
  if (lookup.outcome === "no-map" || lookup.outcome === "empty-ids") {
    const metadata = await lookupSpotifyIdsByMetadata(
      parseArtistsJson(plan.row.artists_json ?? "[]")[0] ?? "",
      plan.row.album ?? "",
      plan.row.title ?? "",
    );
    if (metadata.outcome === "match") {
      lookup = metadata;
      source = "listenbrainz-metadata";
    }
  }
  if (lookup.outcome !== "match") {
    const outcome =
      lookup.outcome === "no-map" || lookup.outcome === "empty-ids"
        ? lookup.outcome
        : lookup.outcome === "invalid-mbid"
          ? "no-mbid"
          : "request-failed";
    return {
      candidate: null,
      candidates: [],
      durationMsOmitted: 0,
      outcome,
      source,
      throttled: false,
    };
  }
  const spotifyTrackId = lookup.match.spotifyTrackIds[0];
  if (!spotifyTrackId) {
    return {
      candidate: null,
      candidates: [],
      durationMsOmitted: 0,
      outcome: "empty-ids",
      source,
      throttled: false,
    };
  }
  if (!(await anchorSpotifyBreakerAllows(now))) {
    return {
      candidate: null,
      candidates: [],
      durationMsOmitted: 0,
      outcome: "yielded-on-breaker",
      source,
      throttled: false,
    };
  }
  const read = await metadataCandidate(spotifyTrackId, now);
  if (!read.candidate) {
    return {
      candidate: null,
      candidates: [],
      durationMsOmitted: 0,
      outcome: "metadata-failed",
      source,
      throttled: read.throttled,
    };
  }
  const accepted = verifiedAnchorPhaseCandidate(plan.row, plan.effectiveIsrc, read.candidate);
  return {
    candidate: accepted ? read.candidate : null,
    candidates: [read.candidate],
    durationMsOmitted: typeof read.candidate.durationMs === "number" ? 0 : 1,
    outcome: accepted ? "anchored" : "gate-rejected",
    source,
    throttled: false,
  };
}

type AnchorSpotifyProbe = {
  candidate: AnchorCandidate | null;
  candidates: AnchorCandidate[];
  durationMsOmitted: number;
  isrcAsked: boolean;
  isrcCleanMiss: boolean;
  searchDone: boolean;
  source: AnchorResolveSource | null;
  throttled: boolean;
};

async function probeSpotifyIsrcPhase(
  plan: AnchorPreparedPhase,
  now: Date,
): Promise<AnchorSpotifyProbe> {
  const isrc = plan.effectiveIsrc;
  if (!isrc) {
    return {
      candidate: null,
      candidates: [],
      durationMsOmitted: 0,
      isrcAsked: false,
      isrcCleanMiss: false,
      searchDone: false,
      source: null,
      throttled: false,
    };
  }
  const lookup = await findSpotifyTrackByIsrc(isrc);
  if (lookup.rateLimited || lookup.unauthorized) {
    return {
      candidate: null,
      candidates: [],
      durationMsOmitted: 0,
      isrcAsked: true,
      isrcCleanMiss: false,
      searchDone: true,
      source: null,
      throttled: lookup.rateLimited,
    };
  }
  const read = lookup.match ? await metadataCandidate(lookup.match.trackId, now) : null;
  const accepted = read?.candidate
    ? verifiedAnchorPhaseCandidate(plan.row, isrc, read.candidate)
    : false;
  return {
    candidate: accepted ? (read?.candidate ?? null) : null,
    candidates: read?.candidate ? [read.candidate] : [],
    durationMsOmitted: read?.candidate && typeof read.candidate.durationMs !== "number" ? 1 : 0,
    isrcAsked: true,
    isrcCleanMiss: !lookup.match || Boolean(read?.candidate && !accepted),
    searchDone: accepted || Boolean(read?.throttled),
    source: accepted ? "spotify-isrc" : null,
    throttled: Boolean(read?.throttled),
  };
}

async function probeSpotifyFuzzyPhase(
  plan: AnchorPreparedPhase,
  _now: Date,
): Promise<AnchorSpotifyProbe> {
  let candidate: AnchorCandidate | null = null;
  let candidates: AnchorCandidate[] = [];
  let durationMsOmitted = 0;
  let throttled = false;
  try {
    const results = await searchTrackCandidates(
      anchorSearchQuery(parseArtistsJson(plan.row.artists_json ?? "[]"), plan.row.title ?? ""),
      "anchor",
    );
    candidates = results.map(searchResultCandidate);
    durationMsOmitted = candidates.filter((item) => typeof item.durationMs !== "number").length;
    candidate = pickAnchorPhaseCandidate(plan.row, plan.effectiveIsrc, candidates) ?? null;
  } catch (error) {
    logEvent("warn", "anchor.spotify-search-failed", { error, trackId: plan.trackId });
    throttled = isSpotifyThrottle(error);
  }
  return {
    candidate,
    candidates,
    durationMsOmitted,
    isrcAsked: false,
    isrcCleanMiss: false,
    searchDone: true,
    source: candidate ? "spotify-search" : null,
    throttled,
  };
}

export async function probeAnchorFreePhase(
  prepared: string,
  spotifySearch = true,
): Promise<string> {
  const plan = await verifyAnchorPhase<AnchorPreparedPhase>(prepared, "prepared");
  const now = new Date();
  const listenbrainz: AnchorListenBrainzProbe = plan.missing
    ? {
        candidate: null,
        candidates: [],
        durationMsOmitted: 0,
        outcome: "not-attempted",
        source: "listenbrainz",
        throttled: false,
      }
    : await probeListenBrainzPhase(plan, now);
  const attempts: AnchorProbeEvidence["attempts"] =
    listenbrainz.candidates.length > 0
      ? [{ candidates: listenbrainz.candidates, source: listenbrainz.source }]
      : [];
  let spotify: AnchorSpotifyProbe = {
    candidate: null,
    candidates: [],
    durationMsOmitted: 0,
    isrcAsked: false,
    isrcCleanMiss: false,
    searchDone: false,
    source: null,
    throttled: false,
  };
  if (
    !plan.missing &&
    !listenbrainz.candidate &&
    spotifySearch &&
    (await anchorSpotifySearchAllowed(now))
  ) {
    spotify = await probeSpotifyIsrcPhase(plan, now);
    if (spotify.candidates.length > 0) {
      attempts.push({ candidates: spotify.candidates, source: "spotify-isrc" });
    }
    if (!spotify.searchDone) {
      const fuzzy = await probeSpotifyFuzzyPhase(plan, now);
      attempts.push({ candidates: fuzzy.candidates, source: "spotify-search" });
      spotify = {
        ...fuzzy,
        durationMsOmitted: spotify.durationMsOmitted + fuzzy.durationMsOmitted,
        isrcAsked: spotify.isrcAsked,
        isrcCleanMiss: spotify.isrcCleanMiss,
        throttled: spotify.throttled || fuzzy.throttled,
      };
    }
  }
  const candidate = listenbrainz.candidate ?? spotify.candidate;
  const source = listenbrainz.candidate ? listenbrainz.source : spotify.source;
  return signAnchorPhase({
    attempts,
    candidate,
    freeDurationMsOmitted: listenbrainz.durationMsOmitted + spotify.durationMsOmitted,
    issuedAt: Date.now(),
    listenbrainzOutcome: listenbrainz.outcome,
    preparedDigest: createHmac("sha256", await anchorPhaseKey())
      .update(prepared)
      .digest("base64url"),
    source,
    spotifyIsrcAsked: spotify.isrcAsked,
    spotifyIsrcCleanMiss: spotify.isrcCleanMiss,
    spotifySearchDone: spotify.searchDone,
    spotifyThrottled: listenbrainz.throttled || spotify.throttled,
    stage: "probed",
  });
}

type AnchorCommitRowState = {
  alreadyAnchored: boolean;
  paidReplay: boolean;
  phaseRecovered: boolean;
  stampedReplay: boolean;
};

function inspectAnchorCommitRow(
  plan: AnchorPreparedPhase,
  proof: AnchorProbeEvidence,
  row: AnchorPhaseRow,
): AnchorCommitRowState {
  const phaseAt = plan.receiptAt;
  const phaseRecovered = row.isrc_recovery_attempted_at === phaseAt;
  const paidReplay = row.spotify_anchor_paid_admitted_at === phaseAt;
  const stampedReplay = row.spotify_anchor_attempted_at === phaseAt;
  const alreadyAnchored = Boolean(row.spotify_uri);
  if (paidReplay) {
    return { alreadyAnchored, paidReplay, phaseRecovered, stampedReplay };
  }
  const anchoredByProbe =
    alreadyAnchored &&
    proof.attempts.some(
      (attempt) =>
        row.spotify_anchor_source === attempt.source &&
        attempt.candidates.some(
          (candidate) => row.spotify_uri === `spotify:track:${candidate.spotifyTrackId}`,
        ),
    );
  const immutableMatches =
    row.artists_json === plan.row.artists_json &&
    row.duration_ms === plan.row.duration_ms &&
    row.title === plan.row.title &&
    row.mb_recording_id === plan.row.mb_recording_id &&
    row.certified === plan.row.certified;
  const mutableMatches =
    (row.spotify_uri === plan.row.spotify_uri || anchoredByProbe) &&
    (row.isrc === plan.row.isrc || (phaseRecovered && row.isrc === plan.effectiveIsrc)) &&
    (row.isrc_recovery_attempted_at === plan.row.isrc_recovery_attempted_at || phaseRecovered) &&
    (row.spotify_isrc_asked_at === plan.row.spotify_isrc_asked_at ||
      (proof.spotifyIsrcCleanMiss && row.spotify_isrc_asked_at === phaseAt) ||
      anchoredByProbe ||
      stampedReplay) &&
    (row.spotify_anchor_attempted_at === plan.row.spotify_anchor_attempted_at ||
      stampedReplay ||
      anchoredByProbe) &&
    (row.spotify_anchor_paid_admitted_at === plan.row.spotify_anchor_paid_admitted_at ||
      paidReplay) &&
    (row.spotify_anchor_paid_state === plan.row.spotify_anchor_paid_state || paidReplay);
  if (!immutableMatches || !mutableMatches || (alreadyAnchored && !anchoredByProbe)) {
    throw new AnchorTrackError("already_anchored", "Anchor row changed after prepare");
  }
  return { alreadyAnchored, paidReplay, phaseRecovered, stampedReplay };
}

async function applyAnchorPhaseResult(
  plan: AnchorPreparedPhase,
  proof: AnchorProbeEvidence,
  row: AnchorPhaseRow,
  state: AnchorCommitRowState,
): Promise<{
  anchored: boolean;
  isrcRecoveredByDeezer: boolean;
  source: AnchorResolveSource | null;
  verifiedBy: AnchorGateVerification;
}> {
  let isrcRecoveredByDeezer =
    !plan.row.isrc?.trim() && state.phaseRecovered && Boolean(row.isrc?.trim());
  if (
    !state.alreadyAnchored &&
    !state.paidReplay &&
    !state.stampedReplay &&
    !state.phaseRecovered &&
    !row.isrc?.trim() &&
    plan.deezerCandidates
  ) {
    const recovered = await recoverIsrcViaDeezer(
      plan.trackId,
      await getDb(),
      parseArtistsJson(row.artists_json ?? "[]"),
      row.title ?? "",
      Number(row.duration_ms),
      plan.deezerCandidates,
      plan.receiptAt,
    );
    isrcRecoveredByDeezer = Boolean(recovered);
  }
  if (state.alreadyAnchored) {
    const candidate = proof.attempts
      .flatMap((attempt) => attempt.candidates)
      .find((item) => row.spotify_uri === `spotify:track:${item.spotifyTrackId}`);
    if (candidate) {
      await connectAnchorArtists(
        plan.trackId,
        candidate.artists.map((artist) => artist.name),
        candidate.artists.map((artist) => artist.id ?? ""),
      );
    }
    return {
      anchored: true,
      isrcRecoveredByDeezer,
      source: row.spotify_anchor_source as AnchorResolveSource,
      verifiedBy: row.spotify_anchor_verified_by as AnchorGateVerification,
    };
  }
  if (state.paidReplay || state.stampedReplay) {
    return { anchored: false, isrcRecoveredByDeezer, source: null, verifiedBy: null };
  }
  for (const attempt of proof.attempts) {
    const verdict = await anchorTrack(plan.trackId, attempt.candidates, {
      source: attempt.source,
      stampOnMiss: false,
    });
    if (verdict.anchored) {
      return { ...verdict, isrcRecoveredByDeezer, source: attempt.source };
    }
  }
  return { anchored: false, isrcRecoveredByDeezer, source: null, verifiedBy: null };
}

async function missingAnchorPhaseResult(): Promise<AnchorResolveResult> {
  const { spotifyIsrcCleanMiss: _ignored, ...noSpotify } = NO_SPOTIFY_OUTCOME;
  return {
    ...noSpotify,
    apifyBudgetRemaining: (await getAnchorApifyBudget()).remainingRows,
    apifyEligible: false,
    apifyEnabled: await isAnchorApifyEnabled(),
    apifyIneligibleReason: null,
    isrcRecoveredByDeezer: false,
    listenbrainzOutcome: "not-attempted",
    spotifySearchEnabled: await isAnchorSpotifySearchEnabled(),
    stamped: false,
  };
}

export async function commitAnchorFreePhase(
  prepared: string,
  evidence: string,
  allowPaid = true,
): Promise<AnchorResolveResult & { paidReceiptPending: boolean }> {
  const plan = await verifyAnchorPhase<AnchorPreparedPhase>(prepared, "prepared");
  const proof = await verifyAnchorPhase<AnchorProbeEvidence>(evidence, "probed");
  const digest = createHmac("sha256", await anchorPhaseKey())
    .update(prepared)
    .digest("base64url");
  if (proof.preparedDigest !== digest) {
    throw new Error("anchor probe does not match its prepared row");
  }
  if (plan.missing) {
    return { ...(await missingAnchorPhaseResult()), paidReceiptPending: false };
  }
  const now = new Date();
  const row = await readAnchorPhaseRow(plan.trackId).catch((error: unknown) => {
    if (error instanceof AnchorTrackError && error.reason === "not_found") {
      return null;
    }
    throw error;
  });
  if (!row) {
    return { ...(await missingAnchorPhaseResult()), paidReceiptPending: false };
  }
  const state = inspectAnchorCommitRow(plan, proof, row);
  const apifyEnabled = await isAnchorApifyEnabled();
  const spotifySearchEnabled = await isAnchorSpotifySearchEnabled();
  const gateReason = (await anchorSpotifySearchGate(now)).reason;
  const { anchored, isrcRecoveredByDeezer, source, verifiedBy } = await applyAnchorPhaseResult(
    plan,
    proof,
    row,
    state,
  );
  const spotifyThrottled = proof.spotifyThrottled;
  const settled = !apifyEnabled && proof.spotifySearchDone && !anchored && !spotifyThrottled;
  const park =
    !apifyEnabled &&
    !spotifySearchEnabled &&
    proof.listenbrainzOutcome !== "yielded-on-breaker" &&
    !proof.spotifySearchDone &&
    !anchored;
  if ((settled || park) && !state.stampedReplay && !state.paidReplay) {
    await stampAnchorAttempt(await getDb(), plan.trackId, plan.receiptAt, {
      chargeAttempt: settled,
    });
  }
  const admission = await admitToApifyRung(await getDb(), plan.trackId, now, {
    allowPaid,
    anchored,
    apifyEnabled,
    gateReason,
    hasIsrc: Boolean(plan.effectiveIsrc),
    priorAsk: Boolean(plan.row.spotify_isrc_asked_at),
    receiptAt: plan.receiptAt,
    spotifyIsrcCleanMiss: proof.spotifyIsrcCleanMiss,
    spotifySearchEnabled,
    spotifySearchSettled: proof.spotifySearchDone && !spotifyThrottled,
  });
  const paidResultToken =
    admission.apifyEligible && (apifyEnabled || state.paidReplay) && !anchored
      ? await signAnchorPhase({
          issuedAt: plan.issuedAt,
          receiptAt: plan.receiptAt,
          stage: "paid-result",
          trackId: plan.trackId,
        })
      : undefined;
  const receipt = await readAnchorPaidReceiptStatus(plan.trackId, plan.receiptAt);
  return {
    anchored,
    ...admission,
    apifyEnabled,
    freeDurationMsOmitted: proof.freeDurationMsOmitted,
    isrcRecoveredByDeezer,
    listenbrainzOutcome: proof.listenbrainzOutcome,
    paidReceiptPending:
      receipt.admitted && hasUnsettledAnchorPaidReceipt(plan.receiptAt, receipt.paidState, now),
    ...(paidResultToken ? { paidResultToken } : {}),
    source,
    spotifyIsrcAsked: proof.spotifyIsrcAsked,
    spotifySearchDone: proof.spotifySearchDone,
    spotifySearchEnabled,
    spotifyThrottled,
    stamped: settled || park || state.stampedReplay,
    verifiedBy,
  };
}

export type AnchorReviewReason = "version_mismatch";

export type AnchorReviewSource =
  | "apify"
  | "deezer"
  | "listenbrainz"
  | "listenbrainz-metadata"
  | "release-link"
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
