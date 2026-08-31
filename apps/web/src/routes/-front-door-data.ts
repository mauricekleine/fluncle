// The FRONT DOOR's server-side composition, lifted out of `index.tsx` so the whole read is a plain
// function a test can drive against a real database — the route's `createServerFn` is a thin wrapper
// that calls `loadFrontDoorData` (the `-`-prefixed sibling-module pattern the other route-logic tests
// use, e.g. `-findings-data.ts`, `-artist-page-data.ts`).
//
// ── WHAT THIS PAGE IS ────────────────────────────────────────────────────────────────────────
// `/` is the way in for someone who arrives knowing nothing and typing nothing. Every section below
// is a read that already exists somewhere else in the app, composed into one deliberate scroll:
//
//   1. the LEAD — the newest finding Fluncle actually wrote about (an operator note on file), which
//      is what makes the placement EDITED rather than merely latest;
//   2. the FINDINGS under it — the next few, newest-found first;
//   3. what just CAME OUT — `/fresh`'s own release window, the one surface whose dates are release
//      dates rather than Found dates (VOICE.md's Found Rule);
//   4. the BROWSE counts — how big each shelf actually is, so the four routes into the archive are
//      offered with a real number rather than a promise.
//
// ── THE TWO REGISTERS ────────────────────────────────────────────────────────────────────────
// The broad archive and the selective findings are related and never conflated. That distinction is
// carried by PLACEMENT and LIGHT alone: a finding is lit and coordinate-bearing, an uncertified row
// is unlit, coverless, and sent out to Spotify (DESIGN.md's Unlit Rule) — and NOTHING here names the
// uncertified tier, counts it separately, or hangs a badge on it. The browse counts are supersets
// ("tracks", "artists"), true of every row under them.
//
// ── WHY EVERY READ IS BOUNDED ────────────────────────────────────────────────────────────────
// One parallel fan-out of reads that are each already capped upstream: the two `listTracks` calls
// carry a `limit`, `listFreshReleases` is window-bounded plus LIMIT-capped, `countAllTracks` is a
// memoized projection read, and the three hub counts are one `count(*)` each over a stored
// `renderable_track_count` column. Nothing here scans a growing table.

import { type TrackListItem } from "@fluncle/contracts";
import { type FreshStreamEntry, freshStream } from "@/components/fresh/data";
import { type FrontDoorCounts } from "@/lib/front-door";
import { countIndexableAlbums } from "@/lib/server/albums";
import { countIndexableArtists } from "@/lib/server/artists";
import { listFreshReleases } from "@/lib/server/fresh";
import { countIndexableLabels } from "@/lib/server/labels";
import { getLiveState, type LiveState } from "@/lib/server/live";
import { countAllTracks } from "@/lib/server/tracks-hub";
import { listTracks, toPublicTrackListItem } from "@/lib/server/tracks";

/** How many findings render under the lead. Small on purpose: this is a door, not the feed. */
export const FRONT_DOOR_FINDINGS = 6;

/** How many releases the "what just came out" section shows before handing over to `/fresh`. */
export const FRONT_DOOR_RELEASES = 8;

export { type FrontDoorCounts } from "@/lib/front-door";

/**
 * Everything `/` renders, in one payload.
 *
 * `lead` is deliberately separate from `findings` rather than being `findings[0]`: the lead is the
 * newest finding with a NOTE on file and the findings are simply the newest, so on a normal archive
 * they are different rows. When they do coincide the loader drops the duplicate from `findings`, so
 * a reader never meets the same finding twice on one screen.
 */
export type FrontDoorData = {
  counts: FrontDoorCounts;
  /** The findings under the lead, newest-found first, never including the lead itself. */
  findings: TrackListItem[];
  /** Every finding in the log — the number the findings section is a window onto. */
  findingsTotal: number;
  /** The edited lead: the newest finding Fluncle wrote about. Absent on an empty archive. */
  lead: TrackListItem | undefined;
  live: LiveState;
  /** What just came out, newest release first — findings and the wider archive, in one stream. */
  releases: FreshStreamEntry[];
  /** Echoed for the honest copy ("the last 30 days"). */
  releaseWindowDays: number;
};

/**
 * Compose the front door's data in one parallel read fan-out. Pure of any route/serverFn machinery
 * so it runs directly against a database under test; `index.tsx`'s `fetchFrontDoorData` serverFn is
 * a one-line call into it.
 *
 * `now` is injectable so the release window is deterministic under test (the `listFreshReleases`
 * precedent it forwards to).
 */
export async function loadFrontDoorData(now: Date = new Date()): Promise<FrontDoorData> {
  const [leadPage, findingsPage, fresh, tracks, artists, labels, albums, live] = await Promise.all([
    // The EDITED lead: newest finding carrying an operator-written note. `hasNote` is the same
    // predicate the auto-note queue reads, so "wrote about it" is a real column, not a heuristic.
    listTracks({ countTotal: false, hasNote: true, lean: true, limit: 1 }),
    // One extra row, so dropping the lead (when it is also the newest finding) still fills the block.
    listTracks({ lean: true, limit: FRONT_DOOR_FINDINGS + 1 }),
    listFreshReleases(now),
    // The four shelf sizes. Each entity count is the INDEXABLE set — every entity whose page
    // clears the thin-content floor, the same set the sitemap submits — which is a hair NARROWER
    // than what the hub itself lists: `hubInclusionWhere` also admits a sub-floor entity that
    // carries a certified finding. The card therefore never promises more than the page holds,
    // which is the direction to be wrong in; the alternative would have a count outrun its own hub.
    countAllTracks(),
    countIndexableArtists(),
    countIndexableLabels(),
    countIndexableAlbums(),
    // The live-set callout, read server-side so the banner SSRs with no flash. Offline almost
    // always — a quiet, cheap read.
    getLiveState(),
  ]);

  // Strip the internal admin/agent-only fields (`PRIVATE_TRACK_FIELDS` — most importantly
  // `sourceAudioKey`, the R2 key of the CAPTURED full song) from every row before it leaves the
  // server. `lean: true` carries those fields for the on-box sweeps; every public read runs its
  // items through `toPublicTrackListItem`.
  // The lead falls back to the newest finding when nothing carries a note yet (a young archive, or
  // one the note sweep has not reached). Still an honest lead, just not yet an edited one, and it
  // keeps the placement from vanishing rather than shipping a hole where the door should be.
  const leadRow = leadPage.tracks[0] ?? findingsPage.tracks[0];
  const lead = leadRow ? toPublicTrackListItem(leadRow) : undefined;
  const findings = findingsPage.tracks
    .map(toPublicTrackListItem)
    .filter((finding) => finding.trackId !== lead?.trackId)
    .slice(0, FRONT_DOOR_FINDINGS);

  return {
    counts: { albums, artists, labels, tracks },
    findings,
    findingsTotal: findingsPage.totalCount,
    lead,
    live,
    releaseWindowDays: fresh.windowDays,
    releases: freshStream(fresh).slice(0, FRONT_DOOR_RELEASES),
  };
}
