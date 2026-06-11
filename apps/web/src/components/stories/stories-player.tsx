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
import { useStoryAudio } from "@/components/stories/use-story-audio";
import { Button } from "@/components/ui/button";
import { type Track } from "@/lib/tracks";

// Without a preview the story runs on a timer instead of the 30s audio clock.
const fallbackDurationMs = 15_000;
const swipeThresholdPx = 60;
const tapMaxMs = 300;
const tapMaxDriftPx = 10;

// The vertical-swipe Stories player — the CINEMATIC register of a log entry
// (the readable one is the /log/<id> plate). One story at a time: full-bleed
// on mobile, a 9:16 pane centered with breathing room at desktop widths;
// flicked through with a vertical swipe, arrow keys, or space; sound is the
// official preview, fading in once the first gesture unlocks it. In "dialog"
// presentation the Stories dialog owns the fixed frame and `onClose` returns
// to the feed via history.back() so the feed keeps its scroll.
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
  const { getClock, muted, pause, play, resume, stop, toggleMuted, unlock, unlocked } =
    useStoryAudio();

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

  const indexRef = useRef(index);
  indexRef.current = index;
  const reducedMotionRef = useRef(false);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  // The timer clock: accumulated ms plus the running stretch since last resume.
  const timerAccumulatedRef = useRef(0);
  const timerStartedAtRef = useRef<number | undefined>(undefined);
  const gestureRef = useRef<
    { interactive: boolean; startedLocked: boolean; t0: number; y0: number } | undefined
  >(undefined);

  const isPaused = held || pausedByUser;
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;
  // Under reduced motion nothing moves uninvited: footage waits for the first
  // gesture (which also unlocks sound) and stories never auto-advance.
  const playbackAllowed = !isPaused && (!reducedMotion || unlocked);

  const track = tracks[index];

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

  // Per-story setup: reset the clock and hand the audio engine the new story.
  // Re-runs when sound unlocks so the current story starts singing mid-view.
  useEffect(() => {
    if (!track) {
      return;
    }

    timerAccumulatedRef.current = 0;
    timerStartedAtRef.current = isPausedRef.current ? undefined : performance.now();
    fillRef.current?.style.setProperty("transform", "scaleX(0)");

    play(track.trackId, () => {
      if (!reducedMotionRef.current) {
        goTo(indexRef.current + 1);
      }
    });
  }, [index, track, unlocked, play, goTo]);

  // Hold / space pause: freeze the audio and the timer clock together.
  useEffect(() => {
    if (isPaused) {
      pause();

      if (timerStartedAtRef.current !== undefined) {
        timerAccumulatedRef.current += performance.now() - timerStartedAtRef.current;
        timerStartedAtRef.current = undefined;
      }
    } else {
      resume();

      if (timerStartedAtRef.current === undefined) {
        timerStartedAtRef.current = performance.now();
      }
    }
  }, [pause, resume, isPaused]);

  // The progress loop writes straight to the segment fill (no re-renders).
  useEffect(() => {
    let frame: number;

    const tick = () => {
      const clock = getClock();
      let progress: number;

      if (clock && clock.duration > 0) {
        progress = clock.elapsed / clock.duration;
      } else {
        const running =
          timerStartedAtRef.current === undefined
            ? 0
            : performance.now() - timerStartedAtRef.current;

        progress = (timerAccumulatedRef.current + running) / fallbackDurationMs;
      }

      progress = Math.min(1, progress);
      fillRef.current?.style.setProperty("transform", `scaleX(${progress})`);

      if (
        progress >= 1 &&
        !reducedMotionRef.current &&
        !isPausedRef.current &&
        indexRef.current < tracks.length - 1
      ) {
        goTo(indexRef.current + 1);
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [getClock, goTo, tracks.length]);

  const close = useCallback(() => {
    if (onClose) {
      onClose();
    } else {
      void navigate({ to: "/" });
    }
  }, [navigate, onClose]);

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

  // Fade everything out when the player unmounts.
  useEffect(() => () => stop(), [stop]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const interactive = Boolean((event.target as HTMLElement).closest("a, button"));

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
    <div
      aria-label="Stories"
      aria-roledescription="story player"
      className="stories-stage"
      data-presentation={presentation}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="region"
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
                  playing={storyIndex === index && playbackAllowed}
                  track={storyTrack}
                />
              </div>
            );
          })}
        </div>

        <header className="stories-chrome">
          <div aria-hidden="true" className="stories-progress">
            {tracks.map((storyTrack, storyIndex) => (
              <span className="stories-segment" key={storyTrack.trackId}>
                <span
                  className="stories-segment-fill"
                  ref={storyIndex === index ? fillRef : undefined}
                  style={storyIndex < index ? { transform: "scaleX(1)" } : undefined}
                />
              </span>
            ))}
          </div>
          <div className="stories-controls">
            <Button
              aria-label={muted ? "Sound on" : "Sound off"}
              aria-pressed={!muted}
              onClick={() => {
                unlock();
                toggleMuted();
              }}
              size="icon"
              variant="ghost"
            >
              {muted || !unlocked ? (
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
    </div>
  );
}
