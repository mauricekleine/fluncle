import { WaveformIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@fluncle/ui/components/dropdown-menu";
import { BrandIcon } from "@/components/brand-icon";
import { LISTEN_META } from "@/components/listen-meta";
import { SaveMenuItem, ShareMenuItem } from "@/components/player/track-menu-items";
import { type TrackActionsTrack } from "@/components/player/track-actions-menu";
import { trackListenLinks } from "@/lib/listen-out";
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
      className="track-menu-content min-w-56 shadow-none"
      side={side}
    >
      {children}
      {trackListenLinks(track).map((link) => {
        const meta = LISTEN_META[link.kind];

        return (
          <DropdownMenuItem
            key={link.kind}
            render={<a aria-label={meta.label} href={link.href} rel="noreferrer" target="_blank" />}
          >
            <BrandIcon className="size-4" icon={meta.icon} />
            {meta.label}
          </DropdownMenuItem>
        );
      })}
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
