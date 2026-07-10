import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type TrackListItem } from "@fluncle/contracts";
import { Button } from "@fluncle/ui/components/button";

// The slim bottom-pinned player for a `/mix` set (RFC mixability-engine §3.3.4). One
// <audio>, sourced from the shipped live relay `/api/preview/<logId>` (re-resolves on
// demand because stored preview tokens expire; open CORS, Range-capable, no-store).
// A straight cut between 30s previews is honest — no fake crossfade. Sound is off
// until the first gesture unlocks it (autoplay-with-sound rules). Reduced-motion:
// never auto-advance — the listener steps the set by hand. A finding with no
// resolvable preview plays as a skip.

const previewSrc = (logId: string) => `/api/preview/${encodeURIComponent(logId)}`;

export function MixPlayer({ chain }: { chain: TrackListItem[] }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const current = chain[index];

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  // Clamp the cursor when the chain shrinks under it (a remove during playback).
  useLayoutEffect(() => {
    if (index > chain.length - 1) {
      setIndex(Math.max(0, chain.length - 1));
    }
  }, [chain.length, index]);

  const advance = useCallback(() => {
    setIndex((previous) => (previous + 1 < chain.length ? previous + 1 : previous));
  }, [chain.length]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    if (audio.paused) {
      void audio.play().then(
        () => setPlaying(true),
        () => setPlaying(false),
      );
    } else {
      audio.pause();
      setPlaying(false);
    }
  }, []);

  // Load the current segment's source when the cursor moves; keep playing if we were.
  useEffect(() => {
    const audio = audioRef.current;

    if (!audio || !current?.logId) {
      return;
    }

    audio.src = previewSrc(current.logId);
    audio.load();

    if (playing) {
      void audio.play().catch(() => setPlaying(false));
    }
    // Intentionally exclude `playing` — we react to the cursor, not to play state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.logId]);

  // Drive the progress fill straight off the audio clock (no per-frame re-render).
  const onTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    const fill = fillRef.current;

    if (!audio || !fill || !audio.duration || Number.isNaN(audio.duration)) {
      return;
    }

    fill.style.transform = `scaleX(${Math.min(1, audio.currentTime / audio.duration)})`;
  }, []);

  const onEnded = useCallback(() => {
    if (reducedMotion) {
      // Reduced-motion: stop at the segment end; the listener advances by hand.
      setPlaying(false);
      return;
    }

    advance();
  }, [advance, reducedMotion]);

  // A finding with no resolvable preview errors out — skip it forward like a cut.
  const onError = useCallback(() => {
    if (!reducedMotion) {
      advance();
    }
  }, [advance, reducedMotion]);

  if (chain.length === 0) {
    return null;
  }

  return (
    <div className="sticky bottom-0 z-10 mt-4 rounded-lg border border-border bg-card/95 px-3 py-2.5 backdrop-blur">
      <div aria-hidden="true" className="mb-2 h-0.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full origin-left bg-primary/70 transition-transform duration-100 ease-linear motion-reduce:transition-none"
          ref={fillRef}
          style={{ transform: "scaleX(0)" }}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          aria-label={playing ? "Pause the set" : "Play the set"}
          onClick={toggle}
          size="icon"
          variant="outline"
        >
          {playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {current ? `${current.artists.join(", ")} — ${current.title}` : "—"}
          </p>
          <p className="truncate font-mono text-[10px] text-muted-foreground tabular-nums">
            {current?.logId} · {index + 1}/{chain.length}
            {reducedMotion ? " · manual" : ""}
          </p>
        </div>
      </div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a 30s music preview has no captions */}
      <audio
        onEnded={onEnded}
        onError={onError}
        onTimeUpdate={onTimeUpdate}
        preload="none"
        ref={audioRef}
      />
    </div>
  );
}
