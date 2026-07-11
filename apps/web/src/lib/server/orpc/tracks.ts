// The `tracks` domain router module. Implements the track-read contract ops off
// the shared implementer the root (../orpc.ts) hands in. A future wave adds an
// op here and one spread line in the root — no other domain's file is touched.

import { ORPCError } from "@orpc/server";
import {
  decodeTrackCursor,
  getMixableTracks,
  getRandomTrack,
  getSimilarFindings,
  listTracks,
  toPublicTrackListItem,
} from "../tracks";
import { resolveLogPageTarget } from "../log-resolver";
import { apiFault, type Implementer, parseLimit } from "./_shared";

// Feed page-size bounds, ported verbatim from the live /api/tracks route.
const LIST_DEFAULT_LIMIT = 16;
const LIST_MAX_LIMIT = 48;

// "More like this" row bounds — a small default (matches the `/log` row) with a
// modest ceiling; the op parses the limit tolerantly like the feed's `list_tracks`.
const SIMILAR_DEFAULT_LIMIT = 6;
const SIMILAR_MAX_LIMIT = 24;

// `/mix` rail bounds — a fuller default than "more like this" (the crew builds a set
// off it), still modestly capped; parsed tolerantly like the feed's `list_tracks`.
const MIXABLE_DEFAULT_LIMIT = 12;
const MIXABLE_MAX_LIMIT = 32;

/**
 * Normalize a discovery-window bound exactly as the live route's `parseTimestamp`
 * did: an invalid value is ignored (degrades to the unwindowed list), a valid one
 * is normalized to ISO so string comparison against the stored `added_at` holds.
 */
function parseTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Build the `tracks` domain's handlers — direct ports of the live route logic,
 * each preserving the success body byte-for-byte (these feed the CLI, MCP, the
 * web app, and the external newsletter agent). Errors are converted through the
 * shared `apiFault` so the rails encoder reproduces the legacy `jsonError` body.
 */
export function tracksHandlers(os: Implementer) {
  // `get_track` — public read of one finding (or mixtape) by Spotify trackId or
  // Log ID. Port of /api/tracks/{idOrLogId} GET: resolve, 404 via ORPCError when
  // absent, else the `{ ok: true } & ({ track } | { mixtape })` envelope.
  const getTrack = os.get_track.handler(async ({ input }) => {
    try {
      const target = await resolveLogPageTarget(input.idOrLogId);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: `No finding for "${input.idOrLogId}"` });
      }

      return target.kind === "mixtape"
        ? ({ mixtape: target.mixtape, ok: true } as const)
        : ({ ok: true, track: toPublicTrackListItem(target.track) } as const);
    } catch (error) {
      // Re-throw oRPC's own errors (the 404 above) so the rails encoder shapes
      // the response; anything else is an unexpected fault.
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  // `list_tracks` — the public merged feed (findings + published mixtapes). Port
  // of /api/tracks GET: clamp the limit, decode the cursor, normalize the
  // discovery window, and drop mixtapes when a window is present. The response is
  // the FeedListPage itself — no `ok` envelope.
  const listTracksHandler = os.list_tracks.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const cursor = decodeTrackCursor(input.cursor ?? null);
      const since = parseTimestamp(input.since);
      const until = parseTimestamp(input.until);

      const page = await listTracks({
        cursor,
        includeMixtapes: since === undefined && until === undefined,
        // The public feed reads the lean list projection (Finding B4): no list surface
        // renders the heavy caption/feature/reasoning fields, and they stay optional on
        // the `list_tracks` contract, so their absence here is additive (get_track still
        // serves the fat single-finding shape for anyone who needs them).
        lean: true,
        limit,
        since,
        until,
      });

      // Strip the private capture key from every item before it world-serves.
      return { ...page, tracks: page.tracks.map(toPublicTrackListItem) };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `get_random_track` — one random certified finding. Port of /api/tracks/random
  // GET: the `{ ok: true, track }` envelope, or a 404 with the custom
  // `track_not_found` code/message (carried as fault data so the rails encoder
  // reproduces the exact legacy `jsonError` body, not the generic `not_found`).
  const getRandomTrackHandler = os.get_random_track.handler(async () => {
    try {
      const track = await getRandomTrack();

      if (!track) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "track_not_found", apiMessage: "No tracks found" },
          message: "No tracks found",
        });
      }

      return { ok: true, track: toPublicTrackListItem(track) } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  // `get_similar_findings` — the N sonically-nearest findings (the "more like this"
  // cluster). Cosine-ranks the target's MuQ embedding against every other
  // coordinate-bearing finding's, self excluded, similarity order. An unknown
  // coordinate / an un-embedded finding / an empty archive all resolve to
  // `{ ok: true, findings: [] }` (a quiet empty row, never a fault). The limit is
  // parsed tolerantly like the feed's, degrading to the default rather than 400-ing.
  const getSimilarFindingsHandler = os.get_similar_findings.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, SIMILAR_DEFAULT_LIMIT, SIMILAR_MAX_LIMIT);
      const findings = await getSimilarFindings(input.idOrLogId, limit);

      return { findings: findings.map(toPublicTrackListItem), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `list_mixable_tracks` — the findings that mix cleanly out of the given one (the
  // `/mix` rail). Ranks the archive by the mixability engine, excludes the already-
  // chained findings server-side, and returns each candidate with its reason chip and
  // NO numeric score. The limit parses tolerantly like the feed's. An unknown
  // coordinate / an all-null target / an empty archive all resolve to `{ findings: [] }`.
  //
  // RATE LIMIT: accept-risk, no limiter (Decision 2). One bounded archive scan,
  // comparable to the existing uncached `get_similar_findings`; the posture is
  // recorded here and revisited at archive growth. Moot while /mix is admin-gated.
  const listMixableTracksHandler = os.list_mixable_tracks.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, MIXABLE_DEFAULT_LIMIT, MIXABLE_MAX_LIMIT);
      const excludeLogIds = (input.exclude ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const findings = await getMixableTracks(input.idOrLogId, { excludeLogIds, limit });

      // Strip the private capture key from every candidate (reason chip stays).
      return {
        findings: findings.map((finding) => ({
          ...toPublicTrackListItem(finding),
          reason: finding.reason,
        })),
        ok: true,
      } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    get_random_track: getRandomTrackHandler,
    get_similar_findings: getSimilarFindingsHandler,
    get_track: getTrack,
    list_mixable_tracks: listMixableTracksHandler,
    list_tracks: listTracksHandler,
  };
}
