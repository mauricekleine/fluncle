// The `stories` domain router module. Implements the public Stories-feed
// contract op off the shared implementer the root (../orpc.ts) hands in. A
// future wave adds an op here and one spread line in the root — no other
// domain's file is touched.

import { decodeTrackCursor, listTracks } from "../tracks";
import { apiFault, type Implementer } from "./_shared";

// Feed page-size bounds, ported verbatim from the live /api/stories route.
const LIST_DEFAULT_LIMIT = 16;
const LIST_MAX_LIMIT = 48;

/**
 * Parse + clamp the incoming `limit` exactly as the live /api/stories route's
 * `parseLimit` did: a missing, non-integer, or < 1 value degrades to the
 * default; otherwise it is capped at the max. The contract keeps `limit` a raw
 * string (coercion would 400 on `?limit=abc`); this reproduces the legacy
 * tolerance.
 */
function parseLimit(value: string | undefined): number {
  if (!value) {
    return LIST_DEFAULT_LIMIT;
  }

  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    return LIST_DEFAULT_LIMIT;
  }

  return Math.min(limit, LIST_MAX_LIMIT);
}

/**
 * Build the `stories` domain's handlers — a direct port of the live /api/stories
 * route, preserving the page body byte-for-byte (no `ok` envelope). Errors are
 * converted through the shared `apiFault` so the rails encoder reproduces the
 * legacy `jsonError` body.
 */
export function storiesHandlers(os: Implementer) {
  // `list_stories` — findings with a rendered video, newest first. Port of
  // /api/stories GET: clamp the limit, decode the cursor, list with the
  // `hasVideo: true` filter. The response is the TrackListPage itself — no `ok`
  // envelope.
  const listStoriesHandler = os.list_stories.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit);
      const cursor = decodeTrackCursor(input.cursor ?? null);

      return await listTracks({ cursor, hasVideo: true, limit });
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { list_stories: listStoriesHandler };
}
