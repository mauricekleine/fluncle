// WHAT JUST CAME OUT — the front door's window onto `/fresh`.
//
// It renders `FreshStreamRow`, the SAME primitive `/fresh` itself renders, so the two surfaces can
// never disagree about what a release looks like. That component owns the register rules: a finding
// leads lit with its coordinate and opens its log page; an uncertified row stays unlit, coverless,
// dust-inked, and goes out to Spotify (DESIGN.md's Unlit Rule). Neither is labelled.
//
// This is the ONE band on the page whose dates are RELEASE dates rather than Found dates, and the
// two are unrelated — a record pressed last week that Fluncle has not logged still belongs here, and
// a banger he found last night off a 2019 record does not. So the copy says "came out", never
// "found" (VOICE.md's Found Rule; lib/server/fresh.ts).

import { type ReactNode } from "react";
import { type FreshStreamEntry } from "@/components/fresh/data";
import { FreshStreamRow } from "@/components/fresh/shared";

export function FrontDoorReleases({
  releases,
  windowDays,
}: {
  releases: FreshStreamEntry[];
  windowDays: number;
}): ReactNode {
  if (releases.length === 0) {
    return (
      <p className="fd-empty empty-scanlines">
        Nothing new off the press in the last {windowDays} days. Quiet stretch.
      </p>
    );
  }

  return (
    <ol className="fd-releases fresh-rows">
      {releases.map((entry) => (
        <FreshStreamRow
          entry={entry}
          key={entry.kind === "finding" ? `f-${entry.finding.trackId}` : `c-${entry.track.trackId}`}
        />
      ))}
    </ol>
  );
}
