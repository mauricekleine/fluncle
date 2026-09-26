import { WaveformIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { siSpotify } from "simple-icons";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@fluncle/ui/components/dropdown-menu";
import { BrandIcon } from "@/components/brand-icon";
import { SaveMenuItem, ShareMenuItem } from "@/components/player/track-menu-items";
import { type TrackActionsTrack } from "@/components/player/track-actions-menu";
import { savableTrack, similarSearchHref } from "@/lib/player-tracks";

export function TrackActionsContent({
  children,
  credit,
  side,
  track,
}: {
  children?: ReactNode;
  credit: string;
  side?: "bottom" | "top";
  track: TrackActionsTrack;
}): ReactNode {
  return (
    <DropdownMenuContent
      align="end"
      className="track-menu-content min-w-48 shadow-none"
      side={side}
    >
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
      {track.similar === false ? null : (
        <DropdownMenuItem
          render={
            <Link data-discovery="similar" preload={false} to={similarSearchHref(track) as never} />
          }
        >
          <WaveformIcon aria-hidden="true" className="size-4" />
          Similar tracks
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <SaveMenuItem track={savableTrack(track)} />
      <ShareMenuItem title={credit} track={track} />
    </DropdownMenuContent>
  );
}
