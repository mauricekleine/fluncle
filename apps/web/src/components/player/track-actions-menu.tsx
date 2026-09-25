// The quiet ⋮ menu: the SAME actions on every row and on the player for the playing track
// (DESIGN.md Track Row, The Quiet Surface Rule). Only what exists is offered — the Spotify mark
// when the track has a Spotify link, and "Similar tracks" into `/search`'s sonic view. A row
// can add its own entries (a finding with footage adds its story) through `children`, which
// render first.
//
// Both entries are real anchors, so the one capture-phase discovery listener classifies them by
// where they go: Spotify as an outbound listen, "Similar tracks" as a similar hop (the
// `data-discovery="similar"` marker on the item — the menu renders in a portal, so the marker
// rides the anchor itself rather than a wrapper).

import { DotsThreeVerticalIcon, WaveformIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { siSpotify } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { similarSearchHref, trackCredit } from "@/lib/player-tracks";
import { type QueueTrack } from "@/lib/preview-player";
import { cn } from "@/lib/utils";

export function TrackActionsMenu({
  children,
  className,
  side,
  track,
}: {
  children?: ReactNode;
  className?: string;
  /** The player opens its menu upward; a row lets the menu pick. */
  side?: "bottom" | "top";
  track: Pick<QueueTrack, "artists" | "spotifyUrl" | "title">;
}): ReactNode {
  const credit = trackCredit(track);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${credit}`}
        className={cn("track-menu-trigger", className)}
      >
        <DotsThreeVerticalIcon aria-hidden="true" size={18} weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44 shadow-none" side={side}>
        {children}
        {track.spotifyUrl ? (
          <DropdownMenuItem
            render={
              <a
                aria-label="Listen on Spotify"
                href={track.spotifyUrl}
                rel="noreferrer"
                target="_blank"
              />
            }
          >
            <BrandIcon className="size-4" icon={siSpotify} />
            Listen on Spotify
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          render={
            // The href is data (a `/search?q=` URL), so the cast happens at this one boundary,
            // exactly as the search rows do it.
            <Link data-discovery="similar" to={similarSearchHref(track) as never} />
          }
        >
          <WaveformIcon aria-hidden="true" className="size-4" />
          Similar tracks
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
