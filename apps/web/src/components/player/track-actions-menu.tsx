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

  side?: "bottom" | "top";
  track: Pick<QueueTrack, "artists" | "id" | "similar" | "spotifyUrl" | "title">;
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
        {track.similar === false ? null : (
          <DropdownMenuItem
            render={
              <Link
                data-discovery="similar"
                preload={false}
                to={similarSearchHref(track) as never}
              />
            }
          >
            <WaveformIcon aria-hidden="true" className="size-4" />
            Similar tracks
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
