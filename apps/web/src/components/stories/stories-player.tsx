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

export function StoriesPlayer({
  initialLogId,
  onClose,
  onStoryChange,
  presentation = "page",
  tracks,
}: {
  initialLogId?: string;

  onClose?: () => void;

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

  const [unlocked, setUnlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const soundOff = !unlocked || muted;

  const indexRef = useRef(index);
  indexRef.current = index;
  const reducedMotionRef = useRef(false);
  const fillRef = useRef<HTMLSpanElement | null>(null);

  const progressRef = useRef<HTMLDivElement | null>(null);

  const activeVideoRef = useRef<HTMLVideoElement | null>(null);

  const timerAccumulatedRef = useRef(0);
  const timerStartedAtRef = useRef<number | undefined>(undefined);

  const endedRef = useRef(false);
  const gestureRef = useRef<
    { interactive: boolean; startedLocked: boolean; t0: number; y0: number } | undefined
  >(undefined);

  const isPaused = held || pausedByUser;
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  const playbackAllowed = !isPaused && (!reducedMotion || unlocked);

  const track = tracks[index];

  const unlock = useCallback(() => setUnlocked(true), []);

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

  useEffect(() => {
    if (!track) {
      return;
    }

    endedRef.current = false;
    timerAccumulatedRef.current = 0;
    timerStartedAtRef.current = isPausedRef.current ? undefined : performance.now();
    fillRef.current?.style.setProperty("transform", "scaleX(0)");

    progressRef.current
      ?.querySelectorAll(".stories-segment.is-loading")
      .forEach((segment) => segment.classList.remove("is-loading"));
  }, [index, track]);

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

  useEffect(() => {
    let frame: number;

    const tick = () => {
      const video = activeVideoRef.current;
      const running =
        timerStartedAtRef.current === undefined ? 0 : performance.now() - timerStartedAtRef.current;

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
