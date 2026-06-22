import { CircleNotchIcon, ShuffleIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { siSpotify } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { TrackSummary } from "@/components/track-summary";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchRandomTrack, type Track } from "@/lib/tracks";

export function RandomBangerDialog() {
  const [open, setOpen] = useState(false);

  // Fetch one banger when the dialog first opens, then hold it across re-opens
  // (staleTime: Infinity — no focus refetch, no second roll on reopen). "Another
  // one" forces a fresh pull via refetch().
  const {
    data: track,
    error,
    isFetching,
    refetch,
  } = useQuery<Track>({
    enabled: open,
    queryFn: fetchRandomTrack,
    queryKey: ["random-banger"],
    staleTime: Infinity,
  });

  const isLoading = isFetching || (!track && !error);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={<Button aria-label="Random banger" size="icon-lg" variant="outline" />}
            />
          }
        >
          <ShuffleIcon aria-hidden="true" weight="bold" />
        </TooltipTrigger>
        <TooltipContent>Random banger</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Random banger</DialogTitle>
          <DialogDescription>The archive throws one back.</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex min-h-24 items-center justify-center gap-2 text-sm font-bold text-muted-foreground">
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            Scanning the archive
          </div>
        ) : undefined}

        {!isLoading && track ? (
          <div className="grid gap-3">
            <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-3 rounded-lg border border-border bg-secondary/50 p-2">
              <TrackSummary
                artists={track.artists}
                artworkUrl={track.albumImageUrl}
                title={track.title}
              />
            </div>
            {track.note ? <p className="text-sm text-muted-foreground">{track.note}</p> : undefined}
            <div className="flex flex-wrap gap-2">
              <Button
                nativeButton={false}
                render={
                  <a
                    aria-label="Listen on Spotify"
                    href={track.spotifyUrl}
                    rel="noreferrer"
                    target="_blank"
                  />
                }
              >
                <BrandIcon icon={siSpotify} />
                Listen on Spotify
              </Button>
              <Button onClick={() => void refetch()} type="button" variant="outline">
                <ShuffleIcon aria-hidden="true" weight="bold" />
                Another one
              </Button>
            </div>
          </div>
        ) : undefined}

        {error ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : String(error)}
          </p>
        ) : undefined}
      </DialogContent>
    </Dialog>
  );
}
