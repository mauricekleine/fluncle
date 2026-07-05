import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@fluncle/ui/components/button";
import { cn } from "@/lib/utils";
import { type VideoSize, useVideoClock } from "./use-video-clock";
import { clampFraction, formatClock, pointerFraction } from "./video-format";

// The `<Video>` compound player. ONE state machine (the radio "one clock" discipline,
// `useVideoClock`) lives in `Video.Root` and is shared through context; the surfaces
// differ only in the CHROME mounted over the same element (a crop frame, an energy
// lane, an auto-hiding scrubber), so this is a compound component, not a boolean-prop
// one. Consumers read the machine via `use(VideoContext)` (or the `useVideo` helper) —
// React 19, no `forwardRef`.
//
//   <Video.Root src autoPlay?>          owns the element + the clock + stall recovery
//     <Video.Surface poster?>           the <video> in a position:relative stage; its
//       …overlays…                      children slot overlays (crop frame, controls)
//     <Video.Controls overlay?>         the controls bar; `overlay` = the auto-hiding
//       <Video.PlayButton/>             scrim band pinned over the stage
//       <Video.Scrubber/>               the seek bar (VibeMap pointer model + keyboard)
//       <Video.Time/>                   the current/total readout

const SEEK_STEP_SECONDS = 5;
// Controls fade out this long after the last activity while playing (overlay surfaces).
const CONTROLS_IDLE_MS = 2_500;

type VideoContextValue = {
  autoPlay: boolean;
  bumpActivity: () => void;
  controlsVisible: boolean;
  currentSeconds: number;
  durationSeconds: number;
  playing: boolean;
  seek: (seconds: number) => void;
  seekFraction: (fraction: number) => void;
  setScrubbing: (scrubbing: boolean) => void;
  src: string | undefined;
  togglePlay: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  videoSize: VideoSize;
};

export const VideoContext = createContext<VideoContextValue | null>(null);

/** Read the player machine. Throws if used outside `<Video.Root>`. */
export function useVideo(): VideoContextValue {
  const value = use(VideoContext);

  if (!value) {
    throw new Error("Video.* and useVideo() must be used within <Video.Root>.");
  }

  return value;
}

function Root({
  autoPlay = false,
  children,
  src,
}: {
  autoPlay?: boolean;
  children: ReactNode;
  src: string | undefined;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clock = useVideoClock({ autoPlay, src, videoRef });

  // The auto-hide model for the overlay controls: visible whenever paused, recently
  // active (hover/scrub bumps a 2.5s idle timer), or actively scrubbing; CSS keeps
  // them up on hover / focus-within too. While PLAYING and idle they fade away.
  const [controlsActive, setControlsActive] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const idleTimer = useRef(0);

  const bumpActivity = useCallback(() => {
    // setState bails when already `true`, so a continuous pointer-move re-renders only
    // on the idle→active edge; the timer still slides forward each move.
    setControlsActive(true);

    if (idleTimer.current) {
      window.clearTimeout(idleTimer.current);
    }

    idleTimer.current = window.setTimeout(() => setControlsActive(false), CONTROLS_IDLE_MS);
  }, []);

  useEffect(
    () => () => {
      if (idleTimer.current) {
        window.clearTimeout(idleTimer.current);
      }
    },
    [],
  );

  const controlsVisible = !clock.playing || controlsActive || scrubbing;

  const value = useMemo<VideoContextValue>(
    () => ({
      autoPlay,
      bumpActivity,
      controlsVisible,
      currentSeconds: clock.currentSeconds,
      durationSeconds: clock.durationSeconds,
      playing: clock.playing,
      seek: clock.seek,
      seekFraction: clock.seekFraction,
      setScrubbing,
      src,
      togglePlay: clock.togglePlay,
      videoRef,
      videoSize: clock.videoSize,
    }),
    [autoPlay, bumpActivity, controlsVisible, clock, src],
  );

  return <VideoContext value={value}>{children}</VideoContext>;
}

function Surface({
  children,
  className,
  mediaClassName,
  poster,
  style,
}: {
  children?: ReactNode;
  className?: string;
  mediaClassName?: string;
  poster?: string;
  style?: CSSProperties;
}) {
  const { autoPlay, bumpActivity, src, videoRef } = useVideo();

  return (
    <div className={cn("video-stage", className)} onPointerMove={bumpActivity} style={style}>
      <video
        autoPlay={autoPlay}
        className={mediaClassName}
        playsInline
        poster={poster}
        preload="metadata"
        ref={videoRef}
        src={src}
      >
        <track kind="captions" />
      </video>
      {children}
    </div>
  );
}

function Controls({
  children,
  className,
  overlay = false,
}: {
  children: ReactNode;
  className?: string;
  overlay?: boolean;
}) {
  const { controlsVisible } = useVideo();

  if (overlay) {
    // The auto-hiding scrim band pinned to the bottom of the stage. `data-visible`
    // drives the playing-idle fade; CSS `:hover`/`:focus-within` on the stage override
    // it so the bar always returns on hover or keyboard focus.
    return (
      <div className={cn("video-overlay-controls", className)} data-visible={controlsVisible}>
        {children}
      </div>
    );
  }

  return <div className={cn("flex items-center gap-3", className)}>{children}</div>;
}

function PlayButton({
  className,
  label,
  size = "icon",
}: {
  className?: string;
  /** A noun appended to the verb, e.g. `label="Crystal Visions"` → "Play Crystal Visions". */
  label?: string;
  size?: "icon" | "icon-sm";
}) {
  const { playing, togglePlay } = useVideo();
  const verb = playing ? "Pause" : "Play";
  const ariaLabel = label ? `${verb} ${label}` : verb;

  return (
    <Button
      aria-label={ariaLabel}
      aria-pressed={playing}
      className={className}
      onClick={togglePlay}
      size={size}
    >
      {playing ? (
        <PauseIcon aria-hidden="true" weight="fill" />
      ) : (
        <PlayIcon aria-hidden="true" weight="fill" />
      )}
    </Button>
  );
}

/**
 * The controlled, canon-styled seek bar. Reads the clock from context; reuses the
 * VibeMap pointer model (getBoundingClientRect + setPointerCapture + clamp) for
 * click/drag-to-seek and carries full keyboard control (←/→ = ±5s, Home/End, Space
 * toggles playback). The thumb is content motion driven off `currentSeconds`
 * (clock-tracked, not CSS-animated), so only the eased hover/focus lift is
 * reduced-motion-gated. Dragging holds the overlay controls open via `setScrubbing`.
 */
function Scrubber({ label = "Seek" }: { label?: string }) {
  const { currentSeconds, durationSeconds, seek, setScrubbing, togglePlay } = useVideo();
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // While dragging, the thumb tracks the pointer directly so it never lags the
  // (debounced) video seek; null hands display back to the clock-driven prop.
  const [dragFraction, setDragFraction] = useState<number | null>(null);

  const hasDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;
  const clockFraction = hasDuration ? clampFraction(currentSeconds / durationSeconds) : 0;
  const fraction = dragFraction ?? clockFraction;

  const fractionFromEvent = useCallback((event: React.PointerEvent) => {
    const track = trackRef.current;

    if (!track) {
      return null;
    }

    const rect = track.getBoundingClientRect();

    return pointerFraction(event.clientX, rect.left, rect.width);
  }, []);

  const seekToFraction = useCallback(
    (next: number) => {
      if (hasDuration) {
        seek(next * durationSeconds);
      }
    },
    [durationSeconds, hasDuration, seek],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!hasDuration) {
        return;
      }

      const next = fractionFromEvent(event);

      if (next === null) {
        return;
      }

      dragging.current = true;
      setScrubbing(true);
      trackRef.current?.setPointerCapture(event.pointerId);
      setDragFraction(next);
      seekToFraction(next);
    },
    [fractionFromEvent, hasDuration, seekToFraction, setScrubbing],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragging.current) {
        return;
      }

      const next = fractionFromEvent(event);

      if (next !== null) {
        setDragFraction(next);
        seekToFraction(next);
      }
    },
    [fractionFromEvent, seekToFraction],
  );

  const endDrag = useCallback(() => {
    dragging.current = false;
    setDragFraction(null);
    setScrubbing(false);
  }, [setScrubbing]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        togglePlay();

        return;
      }

      if (!hasDuration) {
        return;
      }

      let next: number | undefined;

      if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        next = Math.min(durationSeconds, currentSeconds + SEEK_STEP_SECONDS);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        next = Math.max(0, currentSeconds - SEEK_STEP_SECONDS);
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = durationSeconds;
      }

      if (next !== undefined) {
        event.preventDefault();
        seek(next);
      }
    },
    [currentSeconds, durationSeconds, hasDuration, seek, togglePlay],
  );

  const positionStyle = { left: `${fraction * 100}%` };

  return (
    <div
      aria-label={label}
      aria-valuemax={hasDuration ? Math.round(durationSeconds) : 0}
      aria-valuemin={0}
      aria-valuenow={Math.round(currentSeconds)}
      aria-valuetext={`${formatClock(currentSeconds)} of ${formatClock(durationSeconds)}`}
      className="video-scrubber"
      onKeyDown={handleKeyDown}
      onPointerCancel={endDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      ref={trackRef}
      role="slider"
      tabIndex={0}
    >
      <div className="video-scrubber-track">
        <div className="video-scrubber-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className="video-scrubber-thumb" style={positionStyle} />
    </div>
  );
}

function Time({ className }: { className?: string }) {
  const { currentSeconds, durationSeconds } = useVideo();

  return (
    <span aria-hidden="true" className={className}>
      {formatClock(currentSeconds)} / {formatClock(durationSeconds)}
    </span>
  );
}

export const Video = {
  Controls,
  PlayButton,
  Root,
  Scrubber,
  Surface,
  Time,
};
