import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@fluncle/ui/components/button";
import { TrackArtwork } from "@/components/track-artwork";
import { formatDuration } from "@/lib/format";
import { formatKey, type KeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { stopPreview, usePreviewControls, usePreviewProgress } from "@/lib/preview-player";

// The fixed-to-viewport preview panel for /mix (Beatport's now-playing bar, retinted
// to canon: a dark flat panel, quiet, no purchase furniture, a thin gold hairline for
// progress instead of a waveform). It shows whatever the shared preview singleton is
// playing — a chain row OR a candidate row — so previews work on any row.
//
// THE PLATE TRAP: the /mix plate uses backdrop-filter, which makes it the containing
// block for a `position: fixed` descendant — a fixed child would pin to the PLATE, not
// the viewport. The bar is therefore rendered through a portal to document.body. The
// `mounted` guard keeps SSR + first paint empty (createPortal has no server output), so
// hydration matches; the portal only opens post-mount.

const clock = (seconds: number): string => formatDuration(Math.max(0, Math.round(seconds)) * 1000);

/**
 * Exactly what the bar READS, and nothing more — so both its consumers can hand it their own
 * row type without a cast: `/mix`'s `MixTrack` and `/admin/galaxies`' `TrackListItem`. The
 * preview relay is keyed by `logId`, so an uncertified row (no coordinate) can never be the
 * active one, which is why `logId` is optional here rather than absent.
 */
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
  /** Every row that could be previewing right now (chain ∪ rail). Only certified rows can. */
  tracks: PreviewRow[];
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const { activeTrackId, pauseResume, status } = usePreviewControls();
  const { currentTime, duration } = usePreviewProgress();

  const active = activeTrackId ? tracks.find((track) => track.logId === activeTrackId) : undefined;

  // The active preview left the set (its row was removed): stop it so audio never
  // outlives its bar.
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
      <div
        aria-label="Preview"
        className="relative mx-auto flex max-w-2xl items-center gap-3 overflow-hidden rounded-md border border-border bg-card px-3 py-2.5 shadow-lg"
        role="region"
      >
        {/* A thin gold hairline for progress — gold placed like light (One Sun),
            no waveform, no scrubber. Reduced motion drops the eased sweep. */}
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
          {/* aria-live polite: announces the track on change. The ticking clock sits
              on the SEPARATE line below so it never spams the live region. */}
          <p aria-live="polite" className="truncate text-sm font-medium">
            {trackLine}
          </p>
          <p className="track-log-id block truncate">
            {active.logId} · {clock(currentTime)}/{clock(duration)}
            {active.bpm ? ` · ${Math.round(active.bpm)} BPM` : ""}
            {keyText ? ` · ${keyText}` : ""}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
