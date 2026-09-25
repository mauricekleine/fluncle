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
