// The `stories` domain router module. Implements the public Stories-feed
// contract op off the shared implementer the root (../orpc.ts) hands in. A
// future wave adds an op here and one spread line in the root — no other
// domain's file is touched.

import { decodeTrackCursor, listTracks, toPublicTrackListItem } from "../tracks";
import { apiFault, type Implementer, parseLimit } from "./_shared";

// Feed page-size bounds, ported verbatim from the live /api/stories route.
const LIST_DEFAULT_LIMIT = 16;
const LIST_MAX_LIMIT = 48;

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
      const limit = parseLimit(input.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const cursor = decodeTrackCursor(input.cursor ?? null);

      const page = await listTracks({ cursor, hasVideo: true, lean: true, limit });

      // Strip the private capture key (and the internal provenance fields) from every
      // item before it world-serves — the same public-strip the `list_findings` feed runs
      // (orpc/tracks.ts). The lean projection still populates `sourceAudioKey`, so without
      // this the private R2 key of the captured full song would ship on this public feed.
      return { ...page, tracks: page.tracks.map(toPublicTrackListItem) };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { list_stories: listStoriesHandler };
}
