// The `/findings` feed's server-side composition, lifted out of `findings.tsx` so the merge is a plain
// function a test can drive against a real database — the route's `createServerFn` is now a thin
// wrapper that calls `loadFindingsData` (behaviour-identical; the `-`-prefixed sibling-module pattern
// the other route-logic tests use, e.g. `-artist-page.ts`).
//
// Server-rendering the first page keeps the archive readable for crawlers (search engines and AI
// agents alike) that never execute JavaScript. Alongside it we resolve the newest finding WITH
// footage across the whole archive, so the cover's story ring opens the viewer at the latest story
// even when that story isn't on the first page (it usually isn't, once newer findings land before
// their footage does). Same ordering as the stories feed, so it lines up.

import { type FeedListPage } from "@fluncle/contracts";
import { FINDINGS_PAGE_SIZE } from "@/lib/findings-feed";
import { getLiveState, type LiveState } from "@/lib/server/live";
import { listTracks, toPublicTrackListItem } from "@/lib/server/tracks";

export { FINDINGS_PAGE_SIZE } from "@/lib/findings-feed";

/**
 * The `/findings` page's loaded data: the merged first feed page (findings + mixtapes, with its
 * `totalCount` + `nextCursor`), plus the two ambient reads the masthead needs — the newest
 * finding-with-footage's Log ID (the stories entry point) and the live-set state.
 *
 * The Galaxies launch gate is deliberately NOT here: the ROOT loader already resolves it once
 * per request for the nav and the colophon, and the page reads that value — asking for it
 * again here was a second round-trip to the database for an answer already in hand.
 */
export type FindingsData = FeedListPage & {
  live: LiveState;
  newestStoryLogId: string | undefined;
};

/**
 * Compose the `/findings` page's loaded data in one parallel read fan-out. Pure of any route/serverFn
 * machinery so it runs directly against a database under test; `findings.tsx`'s `fetchFindingsData`
 * serverFn is a one-line call into it.
 */
export async function loadFindingsData(): Promise<FindingsData> {
  const [page, latestStory, live] = await Promise.all([
    listTracks({ includeMixtapes: true, lean: true, limit: FINDINGS_PAGE_SIZE }),
    listTracks({ hasVideo: true, lean: true, limit: 1 }),
    // The live-set callout, read server-side so the banner SSRs with no flash (staleness already
    // applied). Offline almost always — a quiet, cheap read.
    getLiveState(),
  ]);

  // Strip the internal admin/agent-only fields (`PRIVATE_TRACK_FIELDS` — most importantly
  // `sourceAudioKey`, the R2 key of the CAPTURED full song) from every feed row before it leaves the
  // server. `lean: true` carries those fields for the on-box sweeps; every OTHER public read runs its
  // items through `toPublicTrackListItem`, and this loader is the one that skipped it — so the
  // edge-cached SSR HTML and the react-query `initialData` seed were shipping them to the world. This
  // also makes the seed byte-identical to what the client refetch (`list_findings`) returns.
  return {
    ...page,
    live,
    newestStoryLogId: latestStory.tracks[0]?.logId,
    tracks: page.tracks.map(toPublicTrackListItem),
  };
}
