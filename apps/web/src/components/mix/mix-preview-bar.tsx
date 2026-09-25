import { PauseIcon, PlayIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@fluncle/ui/components/button";
import { TrackArtwork } from "@/components/track-artwork";
import { formatDuration } from "@/lib/format";
import { formatKey, type KeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { stopPreview, usePreviewControls, usePreviewProgress } from "@/lib/preview-player";

const clock = (seconds: number): string => formatDuration(Math.max(0, Math.round(seconds)) * 1000);

type PreviewRow = {
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  key?: string;
  logId?: string;
  title: string;
};

export function MixPreviewBar({
  notation,
  tracks,
}: {
  notation: KeyNotation;

  tracks: PreviewRow[];
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const { activeTrackId, pauseResume, status } = usePreviewControls();
  const { currentTime, duration } = usePreviewProgress();

  const active = activeTrackId ? tracks.find((track) => track.logId === activeTrackId) : undefined;

  useEffect(() => {
    if (mounted && activeTrackId && !active) {
      stopPreview();
    }
  }, [mounted, activeTrackId, active]);

  if (!mounted || !active) {
    return null;
  }

  const isPlaying = status === "playing" || status === "loading";
  const keyText = formatKey(active.key, notation);
  const fraction = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const trackLine = `${active.artists.join(", ")} — ${active.title}`;

  return createPortal(
    <div className="fixed inset-x-0 bottom-0 z-50 px-4 pb-4 sm:px-6 lg:px-8">
      <section
        aria-label="Preview"
        className="relative mx-auto flex max-w-2xl items-center gap-3 overflow-hidden rounded-md border border-border bg-card px-3 py-2.5"
      >
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-muted">
          <div
            className="h-full origin-left bg-primary transition-transform duration-200 ease-linear motion-reduce:transition-none"
            style={{ transform: `scaleX(${fraction})` }}
          />
        </div>
        <Button
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={pauseResume}
          size="icon"
          variant="outline"
        >
          {isPlaying ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </Button>
        <TrackArtwork alt="" src={albumCoverAtSize(active.albumImageUrl, "small")} />
        <div className="min-w-0 flex-1">
          <p aria-live="polite" className="truncate text-sm font-medium">
            {trackLine}
          </p>
          <p className="track-log-id block truncate">
            {active.logId} · {clock(currentTime)}/{clock(duration)}
            {active.bpm ? ` · ${Math.round(active.bpm)} BPM` : ""}
            {keyText ? ` · ${keyText}` : ""}
          </p>
        </div>

        <Button aria-label="Close preview" onClick={stopPreview} size="icon" variant="outline">
          <XIcon className="size-4" />
        </Button>
      </section>
    </div>,
    document.body,
  );
}
