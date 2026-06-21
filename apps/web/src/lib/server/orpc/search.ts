// The `search` domain router module. Implements the public Spotify-candidate
// search contract op off the shared implementer the root (../orpc.ts) hands in.
// A future wave adds an op here and one spread line in the root — no other
// domain's file is touched.

import { ORPCError } from "@orpc/server";
import { searchTrackCandidates } from "../spotify";
import { apiFault, type Implementer } from "./_shared";

// The live /api/search short-query gate, ported verbatim.
const MIN_QUERY_LENGTH = 2;

/**
 * Build the `search` domain's handlers — a direct port of the live /api/search
 * route, preserving the `{ ok: true, results }` envelope byte-for-byte. The
 * short-query 400 is carried as fault data so the rails encoder reproduces the
 * exact `invalid_query`/400 body the live route hand-rolled (not the generic
 * `bad_request` mapping); upstream Spotify faults flow through `apiFault`.
 */
export function searchHandlers(os: Implementer) {
  // `search_tracks` — Spotify candidate search for the submit flow. Port of
  // /api/search GET: trim the `q` param, 400 with `invalid_query` when under the
  // length floor, else the `{ ok: true, results }` envelope.
  const searchTracksHandler = os.search_tracks.handler(async ({ input }) => {
    const query = input.q?.trim() ?? "";

    if (query.length < MIN_QUERY_LENGTH) {
      throw new ORPCError("BAD_REQUEST", {
        data: {
          apiCode: "invalid_query",
          apiMessage: "Search query must be at least 2 characters",
        },
        message: "Search query must be at least 2 characters",
      });
    }

    try {
      return { ok: true, results: await searchTrackCandidates(query) } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { search_tracks: searchTracksHandler };
}
