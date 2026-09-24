// The `/tracks` hub row: the shared discovery row (`components/discovery-row.tsx`), fed from the
// hub's two-register entry.
//
// Both registers lead with the REAL album cover, and the cover is the play button: a finding shows
// it in full colour, links its title to `/log/<logId>` and carries its coordinate; a catalogue row
// shows the same kind of cover desaturated and dimmed (its lead artist's portrait, dimmed, when the
// record has no cover), links its title to its own `/track/<trackId>` destination, and carries no
// coordinate and no gold. The artists and the imprint are GraphLinks on the metadata line, with the
// release year beside them; the readout chips sit beneath. There is no date column.
//
// THE SPLIT STAYS VISUAL, and only visual (DESIGN.md's Unlit Rule): no word on the row says which
// register it is in. The mapping from the hub's entry lives in `lib/discovery-tracks.ts`, beside
// every other list's, so the hub cannot drift from `/search`, `/fresh` or the entity pages.

import { type ReactNode } from "react";
import { DiscoveryRow } from "@/components/discovery-row";
import { hubEntryToDiscoveryTrack } from "@/lib/discovery-tracks";
import { type TracksHubEntry } from "@/lib/server/tracks-hub";

/** One row of the `/tracks` hub, in the register its entry declares. */
export function TracksHubRow({ entry }: { entry: TracksHubEntry }): ReactNode {
  return <DiscoveryRow track={hubEntryToDiscoveryTrack(entry)} />;
}
