// WHAT JUST CAME OUT — the front door's window onto `/fresh`.
//
// It renders `FreshReleaseRows`, the SAME primitive `/fresh` itself renders, so the two surfaces
// can never disagree about what a release looks like. The shared discovery row owns the register
// rules: a finding leads lit with its coordinate and opens its log page; an uncertified row shows its
// real cover dimmed and opens its own destination (DESIGN.md's Unlit Rule). Neither is labelled. The
// band is one list to the player: a cover plays the releases from there, and nothing on the page
// moves because it did.
//
// This is the ONE band on the page whose dates are RELEASE dates rather than Found dates, and the
// two are unrelated — a record pressed last week that Fluncle has not logged still belongs here, and
// a banger he found last night off a 2019 record does not. So the copy says "came out", never
// "found" (VOICE.md's Found Rule; lib/server/fresh.ts).

import { type ReactNode, useMemo } from "react";
import { DiscoveryPlayableList } from "@/components/discovery-row";
import { type FreshStreamEntry } from "@/components/fresh/data";
import { FreshReleaseRows } from "@/components/fresh/shared";
import { freshEntryToDiscoveryTrack } from "@/lib/discovery-tracks";

export function FrontDoorReleases({
  releases,
  windowDays,
}: {
  releases: FreshStreamEntry[];
  windowDays: number;
}): ReactNode {
  const tracks = useMemo(() => releases.map(freshEntryToDiscoveryTrack), [releases]);

  if (releases.length === 0) {
    return (
      <p className="fd-empty empty-scanlines">
        Nothing new off the press in the last {windowDays} days. Quiet stretch.
      </p>
    );
  }

  return (
    <DiscoveryPlayableList tracks={tracks}>
      <FreshReleaseRows className="fd-releases" entries={releases} />
    </DiscoveryPlayableList>
  );
}
