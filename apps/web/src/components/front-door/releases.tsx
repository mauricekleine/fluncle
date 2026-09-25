import { type ReactNode, useMemo } from "react";
import { DiscoveryPlayableList } from "@/components/discovery-row";
import { FreshReleaseList } from "@/components/fresh/release-entry";
import { type FreshRelease, releasesQueue } from "@/lib/fresh-releases";

export function FrontDoorReleases({
  releases,
  windowDays,
}: {
  releases: FreshRelease[];
  windowDays: number;
}): ReactNode {
  const tracks = useMemo(() => releasesQueue(releases), [releases]);

  if (releases.length === 0) {
    return (
      <p className="fd-empty empty-scanlines">
        Nothing new off the press in the last {windowDays} days. Quiet stretch.
      </p>
    );
  }

  return (
    <DiscoveryPlayableList tracks={tracks}>
      <FreshReleaseList className="fd-releases" releases={releases} />
    </DiscoveryPlayableList>
  );
}
