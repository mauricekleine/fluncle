import { SpeakerSimpleHighIcon, SpeakerSimpleSlashIcon, XIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { StoryView } from "@/components/stories/story-view";
import { Button } from "@fluncle/ui/components/button";
import { storyProgress } from "@/lib/story-progress";
import { type Track } from "@/lib/tracks";

const swipeThresholdPx = 60;
const tapMaxMs = 300;
const tapMaxDriftPx = 10;

// The vertical-swipe Stories player — the CINEMATIC register of a log entry
// (the readable one is the /log/<id> plate). One story at a time: full-bleed on
// mobile, a 9:16 pane centered with breathing room at desktop widths; flicked
// through with a vertical swipe, arrow keys, or space. The CLIP carries both the
// sound and the timing: the player reads the active <video>'s clock and advances
// when it ends — no separate preview audio overlaid on a clip that may be
// shorter. Sound is muted until the first gesture unlocks it (autoplay rules).
// In "dialog" presentation the Stories dialog owns the fixed frame and `onClose`
// returns to the feed via history.back() so the feed keeps its scroll.
export function StoriesPlayer({
  initialLogId,
  onClose,
  onStoryChange,
  presentation = "page",
  tracks,
}: {
  initialLogId?: string;
  /** Close handler; defaults to navigating home (the standalone-origin fallback). */
  onClose?: () => void;
  /**
   * Owns the per-flick URL when provided (the dialog passes a masked replace
   * navigation). Without it the player falls back to a raw replaceState —
   * NEVER do that under route masking: rewriting the entry drops the router's
   * __tempLocation state and the masked URL's route takes over the screen.
   */
  onStoryChange?: (logId: string) => void;
  presentation?: "dialog" | "page";
  tracks: Track[];
}) {
  const navigate = useNavigate();

  const initialIndex = initialLogId
    ? Math.max(
        0,
        tracks.findIndex((track) => track.logId === initialLogId),
      )
    : 0;
  const [index, setIndex] = useState(initialIndex);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [held, setHeld] = useState(false);
  const [pausedByUser, setPausedByUser] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  // Sound is off until the first gesture unlocks it (autoplay-with-sound is
  // blocked); after that the toggle controls it.
  const [unlocked, setUnlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const soundOff = !unlocked || muted;

  const indexRef = useRef(index);
  indexRef.current = index;
  const reducedMotionRef = useRef(false);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  // The progress strip, so a story switch can clear a stale loading shimmer off
  // whichever segment was carrying it.
  const progressRef = useRef<HTMLDivElement | null>(null);
  // The active story's <video> — the clip clock; null for a cover-only story.
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  // The fallback timer clock (clip-less stories): accumulated ms plus the
  // running stretch since last resume.
  const timerAccumulatedRef = useRef(0);
  const timerStartedAtRef = useRef<number | undefined>(undefined);
  // Guards a double close when the last story's end fires across frames.
  const endedRef = useRef(false);
  const gestureRef = useRef<
    { interactive: boolean; startedLocked: boolean; t0: number; y0: number } | undefined
  >(undefined);

  const isPaused = held || pausedByUser;
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;
  // Under reduced motion nothing moves uninvited: the clip waits for the first
  // gesture (which also unlocks sound) and stories never auto-advance.
  const playbackAllowed = !isPaused && (!reducedMotion || unlocked);

  const track = tracks[index];

  const unlock = useCallback(() => setUnlocked(true), []);
  // The active story hands its <video> here so the progress loop can clock it.
  const onActiveVideo = useCallback((video: HTMLVideoElement | null) => {
    activeVideoRef.current = video;
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      reducedMotionRef.current = query.matches;
      setReducedMotion(query.matches);
    };

    apply();
    query.addEventListener("change", apply);

    return () => query.removeEventListener("change", apply);
  }, []);

  const goTo = useCallback(
    (nextIndex: number) => {
      const clamped = Math.max(0, Math.min(tracks.length - 1, nextIndex));

      setDragOffset(0);
      setIsDragging(false);

      if (clamped !== indexRef.current) {
        setPausedByUser(false);
        setIndex(clamped);
      }
    },
    [tracks.length],
  );

  const close = useCallback(() => {
    if (onClose) {
      onClose();
    } else {
      void navigate({ to: "/" });
    }
  }, [navigate, onClose]);

  // Per-story setup: reset the fallback timer and the progress fill. The active
  // <video> resets/plays from StoryView and re-points activeVideoRef there.
  useEffect(() => {
    if (!track) {
      return;
    }

    endedRef.current = false;
    timerAccumulatedRef.current = 0;
    timerStartedAtRef.current = isPausedRef.current ? undefined : performance.now();
    fillRef.current?.style.setProperty("transform", "scaleX(0)");
    // Drop any loading shimmer left on the segment we just stepped off; the tick
    // re-applies it to the new active segment if its clip is still loading.
    progressRef.current
      ?.querySelectorAll(".stories-segment.is-loading")
      .forEach((segment) => segment.classList.remove("is-loading"));
  }, [index, track]);

  // Hold / space pause freezes the clip-less timer clock; the clip itself
  // pauses through the `playing` prop.
  useEffect(() => {
    if (isPaused) {
      if (timerStartedAtRef.current !== undefined) {
        timerAccumulatedRef.current += performance.now() - timerStartedAtRef.current;
        timerStartedAtRef.current = undefined;
      }
    } else if (timerStartedAtRef.current === undefined) {
      timerStartedAtRef.current = performance.now();
    }
  }, [isPaused]);

  // The progress loop writes straight to the segment fill (no re-renders) and,
  // when the clip (or timer) runs out, advances — or, on the last story, leaves
  // the player (back to the feed / home).
  useEffect(() => {
    let frame: number;

    const tick = () => {
      const video = activeVideoRef.current;
      const running =
        timerStartedAtRef.current === undefined ? 0 : performance.now() - timerStartedAtRef.current;

      // A clip-bearing story clocks (and gates) on its clip; a cover-only story
      // runs the fallback timer. The gate holds a still-loading clip at 0 and
      // reports `loading` so the bar can't finish (and auto-advance) over a
      // frozen poster.
      const verdict = storyProgress({
        currentTime: video?.currentTime ?? 0,
        duration: video?.duration ?? NaN,
        fallbackElapsedMs: timerAccumulatedRef.current + running,
        hasClip: video !== null,
        readyState: video?.readyState ?? 0,
      });

      const fill = fillRef.current;

      if (fill) {
        fill.style.setProperty("transform", `scaleX(${verdict.progress})`);
        // While the clip loads, shimmer this segment (a static dimmed sweep
        // under reduced motion — handled in CSS). Toggled imperatively to match
        // the no-re-render progress write above.
        fill.parentElement?.classList.toggle("is-loading", verdict.loading);
      }

      if (verdict.finished && !reducedMotionRef.current && !isPausedRef.current) {
        if (indexRef.current < tracks.length - 1) {
          goTo(indexRef.current + 1);
        } else if (!endedRef.current) {
          endedRef.current = true;
          close();
        }
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [close, goTo, tracks.length]);

  // Keep the URL on the current story so every flick is shareable.
  const onStoryChangeRef = useRef(onStoryChange);
  onStoryChangeRef.current = onStoryChange;
  useEffect(() => {
    if (!track?.logId) {
      return;
    }

    if (onStoryChangeRef.current) {
      onStoryChangeRef.current(track.logId);
    } else {
      window.history.replaceState(null, "", `/log/${encodeURIComponent(track.logId)}`);
    }
  }, [track?.logId]);

  // In dialog presentation Escape belongs to the Dialog (its own handler
  // closes via onOpenChange); handling it here too would close twice — and a
  // double history.back() jumps an extra entry.
  const ownsEscape = presentation !== "dialog";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        unlock();
        goTo(indexRef.current + 1);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        unlock();
        goTo(indexRef.current - 1);
      } else if (event.key === " ") {
        event.preventDefault();
        unlock();
        setPausedByUser((paused) => !paused);
      } else if (event.key === "Escape" && ownsEscape) {
        event.preventDefault();
        close();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [unlock, goTo, close, ownsEscape]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const interactive = Boolean(target.closest("a, button"));

    // Desktop dialog: the full-bleed DialogContent IS the stage, so Base UI's
    // own click-outside never fires. A press on the letterbox (anything outside
    // the 9:16 pane) is a backdrop click — close, don't read it as a play
    // gesture (which is why a click beside the pane used to pause, not close).
    if (presentation === "dialog" && !interactive && !target.closest(".stories-viewport")) {
      close();
      return;
    }

    gestureRef.current = {
      interactive,
      startedLocked: !unlocked,
      t0: performance.now(),
      y0: event.clientY,
    };

    if (interactive) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    unlock();
    setHeld(true);
    setIsDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;

    if (!gesture || gesture.interactive) {
      return;
    }

    let delta = event.clientY - gesture.y0;

    // Resist dragging past either end of the log.
    if (
      (indexRef.current === 0 && delta > 0) ||
      (indexRef.current === tracks.length - 1 && delta < 0)
    ) {
      delta *= 0.35;
    }

    setDragOffset(delta);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    gestureRef.current = undefined;

    if (!gesture || gesture.interactive) {
      return;
    }

    setHeld(false);

    const delta = event.clientY - gesture.y0;
    const elapsed = performance.now() - gesture.t0;

    if (delta <= -swipeThresholdPx) {
      goTo(indexRef.current + 1);
    } else if (delta >= swipeThresholdPx) {
      goTo(indexRef.current - 1);
    } else {
      setDragOffset(0);
      setIsDragging(false);

      // A clean tap: the first one only unlocks sound, the rest toggle pause.
      if (elapsed < tapMaxMs && Math.abs(delta) < tapMaxDriftPx && !gesture.startedLocked) {
        setPausedByUser((paused) => !paused);
      }
    }
  }

  function onPointerCancel() {
    gestureRef.current = undefined;
    setHeld(false);
    setDragOffset(0);
    setIsDragging(false);
  }

  if (!track) {
    return null;
  }

  return (
    <section
      aria-label="Stories"
      aria-roledescription="story player"
      className="stories-stage"
      data-presentation={presentation}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="stories-viewport">
        <div
          className="stories-track"
          style={{
            transform: `translateY(calc(${-index * 100}% + ${dragOffset}px))`,
            transition: isDragging || reducedMotion ? "none" : undefined,
          }}
        >
          {tracks.map((storyTrack, storyIndex) => {
            // ±1 preload window: neighbours mount (and buffer), the rest tear down.
            if (Math.abs(storyIndex - index) > 1) {
              return null;
            }

            return (
              <div
                className="story-slot"
                key={storyTrack.trackId}
                style={{ transform: `translateY(${storyIndex * 100}%)` }}
              >
                <StoryView
                  active={storyIndex === index}
                  muted={soundOff}
                  onActiveVideo={onActiveVideo}
                  playing={storyIndex === index && playbackAllowed}
                  track={storyTrack}
                />
              </div>
            );
          })}
        </div>

        <header className="stories-chrome">
          <div aria-hidden="true" className="stories-progress" ref={progressRef}>
            {tracks.map((storyTrack, storyIndex) => (
              <span className="stories-segment" key={storyTrack.trackId}>
                {/* Past = full, current = animated (fillRef), future = empty.
                    Future is set explicitly (not undefined) so a segment that
                    was once current can't keep a stale half-filled transform. */}
                <span
                  className="stories-segment-fill"
                  ref={storyIndex === index ? fillRef : undefined}
                  style={
                    storyIndex < index
                      ? { transform: "scaleX(1)" }
                      : storyIndex > index
                        ? { transform: "scaleX(0)" }
                        : undefined
                  }
                />
              </span>
            ))}
          </div>
          <div className="stories-controls">
            <Button
              aria-label={soundOff ? "Sound on" : "Sound off"}
              aria-pressed={!soundOff}
              onClick={() => {
                unlock();
                setMuted((value) => !value);
              }}
              size="icon"
              variant="ghost"
            >
              {soundOff ? (
                <SpeakerSimpleSlashIcon aria-hidden="true" weight="bold" />
              ) : (
                <SpeakerSimpleHighIcon aria-hidden="true" weight="bold" />
              )}
            </Button>
            <Button aria-label="Back to the archive" onClick={close} size="icon" variant="ghost">
              <XIcon aria-hidden="true" weight="bold" />
            </Button>
          </div>
        </header>

        {unlocked ? undefined : <p className="stories-sound-hint">Tap for sound</p>}
      </div>

      <p aria-live="polite" className="sr-only">
        {`Story ${index + 1} of ${tracks.length}: ${track.artists.join(", ")} - ${track.title}`}
      </p>
    </section>
  );
}
