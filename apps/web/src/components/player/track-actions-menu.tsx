import { DotsThreeVerticalIcon } from "@phosphor-icons/react";
import { type ReactNode, Suspense, useState } from "react";
import { DropdownMenu, DropdownMenuTrigger } from "@fluncle/ui/components/dropdown-menu";
import { LazyPopupBoundary } from "@/components/lazy-popup-boundary";
import { lazyNamed } from "@/lib/lazy-named";
import { trackCredit } from "@/lib/player-tracks";
import { type QueueTrack } from "@/lib/preview-player";
import { cn } from "@/lib/utils";

const loadTrackActionsContent = () => import("@/components/player/track-actions-content");
const TrackActionsContent = lazyNamed(loadTrackActionsContent, "TrackActionsContent");

export type TrackActionsTrack = Pick<
  QueueTrack,
  "artists" | "coverUrl" | "href" | "id" | "logId" | "similar" | "spotifyUrl" | "title"
>;

function prefetchTrackActionsContent(): void {
  void loadTrackActionsContent();
}

export function TrackActionsMenu({
  children,
  className,
  side,
  track,
}: {
  children?: ReactNode;
  className?: string;

  side?: "bottom" | "top";
  track: TrackActionsTrack;
}): ReactNode {
  const credit = trackCredit(track);
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);

  function onOpenChange(next: boolean): void {
    if (next) {
      setActivated(true);
    }

    setOpen(next);
  }

  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger
        aria-label={`Actions for ${credit}`}
        className={cn("track-menu-trigger", className)}
        onFocus={prefetchTrackActionsContent}
        onPointerDown={prefetchTrackActionsContent}
        onPointerEnter={prefetchTrackActionsContent}
      >
        <DotsThreeVerticalIcon aria-hidden="true" size={18} weight="bold" />
      </DropdownMenuTrigger>
      {open || activated ? (
        <LazyPopupBoundary>
          <Suspense fallback={null}>
            <TrackActionsContent credit={credit} side={side} track={track}>
              {children}
            </TrackActionsContent>
          </Suspense>
        </LazyPopupBoundary>
      ) : null}
    </DropdownMenu>
  );
}
