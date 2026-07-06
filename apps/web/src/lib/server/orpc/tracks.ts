// The `tracks` domain router module. Implements the track-read contract ops off
// the shared implementer the root (../orpc.ts) hands in. A future wave adds an
// op here and one spread line in the root — no other domain's file is touched.

import { ORPCError } from "@orpc/server";
import { decodeTrackCursor, getRandomTrack, getSimilarFindings, listTracks } from "../tracks";
import { resolveLogPageTarget } from "../log-resolver";
import { apiFault, type Implementer, parseLimit } from "./_shared";

// Feed page-size bounds, ported verbatim from the live /api/tracks route.
const LIST_DEFAULT_LIMIT = 16;
const LIST_MAX_LIMIT = 48;

// "More like this" row bounds — a small default (matches the `/log` row) with a
// modest ceiling; the op parses the limit tolerantly like the feed's `list_tracks`.
const SIMILAR_DEFAULT_LIMIT = 6;
const SIMILAR_MAX_LIMIT = 24;

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
        : ({ ok: true, track: target.track } as const);
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

      return await listTracks({
        cursor,
        includeMixtapes: since === undefined && until === undefined,
        limit,
        since,
        until,
      });
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

      return { ok: true, track } as const;
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

      return { findings, ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    get_random_track: getRandomTrackHandler,
    get_similar_findings: getSimilarFindingsHandler,
    get_track: getTrack,
    list_tracks: listTracksHandler,
  };
}
