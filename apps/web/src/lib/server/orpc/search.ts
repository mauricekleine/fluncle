// The `search` domain router module. Implements the public Spotify-candidate
// search contract op off the shared implementer the root (../orpc.ts) hands in.
// A future wave adds an op here and one spread line in the root — no other
// domain's file is touched.

import { ORPCError } from "@orpc/server";
import { assertRateLimit } from "../rate-limit";
import { searchArchive } from "../search";
import { searchTracks } from "../track-search";
import { apiFault, type Implementer } from "./_shared";

// The live /api/search short-query gate, ported verbatim. Exported because it is the
// shared floor BOTH agent mounts advertise as their `minLength: 2` (see the
// mcp-webmcp-parity test): the contract deliberately carries no minimum, so the
// handler can emit the hand-rolled `invalid_query` 400 rather than a schema rejection.
export const MIN_QUERY_LENGTH = 2;

// search_archive's own per-IP budget (its handler below says why it needs one).
// search_tracks' budget is NOT here: that op is mounted twice — this HTTP op and the
// MCP tool — so its limiter lives with the capability itself, in ../track-search.ts,
// where neither mount can be wired up without it.
const SEARCH_LIMIT = 30;
const SEARCH_WINDOW_MS = 60 * 1000;

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
  const searchTracksHandler = os.search_tracks.handler(async ({ context, input }) => {
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
      // ../track-search guards the shared Spotify token (limiter first, then the
      // recent-query cache) for this mount AND the MCP one.
      return {
        ok: true,
        results: await searchTracks({ query, request: context.request }),
      } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `search_archive` — Fluncle's own search (lib/server/search.ts). Unlike `search_tracks`
  // it burns no vendor token on a common query: three of its four tiers are pure database
  // reads. The fourth can reach an LLM, so it carries the SAME shared limiter — a script
  // grinding natural-language queries would be spending real money, and the limiter is what
  // makes that bounded. A short query returns the empty envelope rather than a 400: this
  // one is typed into a live dialog, so "not enough to go on yet" is a normal state, not an
  // error.
  const searchArchiveHandler = os.search_archive.handler(async ({ context, input }) => {
    const query = input.q.trim();

    if (query.length < MIN_QUERY_LENGTH) {
      return { degraded: false, entities: [], kind: "empty", ok: true, results: [] } as const;
    }

    try {
      await assertRateLimit({
        action: "search_archive",
        limit: SEARCH_LIMIT,
        request: context.request,
        windowMs: SEARCH_WINDOW_MS,
      });

      return { ok: true, ...(await searchArchive({ limit: input.limit, q: query })) } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { search_archive: searchArchiveHandler, search_tracks: searchTracksHandler };
}
