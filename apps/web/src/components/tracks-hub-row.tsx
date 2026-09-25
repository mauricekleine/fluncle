import { type ReactNode } from "react";
import { DiscoveryRow } from "@/components/discovery-row";
import { hubEntryToDiscoveryTrack } from "@/lib/discovery-tracks";
import { type TracksHubEntry } from "@/lib/server/tracks-hub";

export function TracksHubRow({ entry }: { entry: TracksHubEntry }): ReactNode {
  return <DiscoveryRow track={hubEntryToDiscoveryTrack(entry)} />;
}
