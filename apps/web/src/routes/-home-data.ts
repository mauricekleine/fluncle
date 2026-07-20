// The home feed's server-side composition, lifted out of `index.tsx` so the merge is a plain
// function a test can drive against a real database — the route's `createServerFn` is now a thin
// wrapper that calls `loadHomeData` (behaviour-identical; the `-`-prefixed sibling-module pattern
// the other route-logic tests use, e.g. `-artist-page.ts`).
//
// Server-rendering the first page keeps the archive readable for crawlers (search engines and AI
// agents alike) that never execute JavaScript. Alongside it we resolve the newest finding WITH
// footage across the whole archive, so the cover's story ring opens the viewer at the latest story
// even when that story isn't on the first page (it usually isn't, once newer findings land before
// their footage does). Same ordering as the stories feed, so it lines up.

import { type FeedListPage } from "@fluncle/contracts";
import { isGalaxyMapFullyNamed } from "@/lib/server/galaxies-map";
import { getLiveState, type LiveState } from "@/lib/server/live";
import { listTracks } from "@/lib/server/tracks";

/** How many feed rows the home loader server-renders — page one of the infinite feed. */
export const HOME_PAGE_SIZE = 10;

/**
 * The home page's loaded data: the merged first feed page (findings + mixtapes, with its
 * `totalCount` + `nextCursor`), plus the three ambient reads the masthead needs — the newest
 * finding-with-footage's Log ID (the stories entry point), the live-set state, and the Galaxies
 * launch gate.
 */
export type HomeData = FeedListPage & {
  galaxiesLive: boolean;
  live: LiveState;
  newestStoryLogId: string | undefined;
};

/**
 * Compose the home page's loaded data in one parallel read fan-out. Pure of any route/serverFn
 * machinery so it runs directly against a database under test; `index.tsx`'s `fetchHomeData`
 * serverFn is a one-line call into it.
 */
export async function loadHomeData(): Promise<HomeData> {
  const [page, latestStory, live, galaxiesLive] = await Promise.all([
    listTracks({ includeMixtapes: true, lean: true, limit: HOME_PAGE_SIZE }),
    listTracks({ hasVideo: true, lean: true, limit: 1 }),
    // The live-set callout, read server-side so the banner SSRs with no flash (staleness already
    // applied). Offline almost always — a quiet, cheap read.
    getLiveState(),
    // The browse-by-feel launch gate (decision 5): the dev-row Galaxies link stays dark until the
    // whole sonic map is named, so the homepage never links a lens that 404s. One cheap COUNT; lights
    // up the moment the last name lands.
    isGalaxyMapFullyNamed(),
  ]);

  return { ...page, galaxiesLive, live, newestStoryLogId: latestStory.tracks[0]?.logId };
}
