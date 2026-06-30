import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { mixtapeCoverUrl } from "@/lib/mixtapes";
import { mixtapeSetVideoUrl } from "@/lib/media";
import { useVideoStallRecovery } from "@/lib/use-video-recovery";

// The mixtape `/log` set player: a branded, canon-styled `<video>` with a real
// SEEK scrubber — the finding footage player is play/pause-only (fine for a 30s
// loop, useless for a ~72-min set). The set video is the bare R2 master
// (`<log-id>/set.mp4`, range-streamed + faststart) — NOT a Cloudflare Media
// Transformation: the file is well past MT's 100MB source ceiling, so the player
// fetches the master directly and the browser range-seeks it.
//
// The playhead is driven off the video's OWN clock (`currentTime`, sampled via
// requestVideoFrameCallback where available, else rAF) — the radio "one clock"
// discipline: the element is the single source of truth, the UI only reflects it.
//
// `VideoScrubber` is split out as a controlled, presentation-only seek bar so the
// planned Fluncle Studio editor can reuse the
// exact scrubber over its own preview element.

const SEEK_STEP_SECONDS = 5;

/** H:MM:SS for an hour-plus set, M:SS below the hour. Tabular-friendly, padded. */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }

  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

const clampFraction = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The pure pointer→position mapping behind the scrubber (the VibeMap model): a
 * pointer x against the track's left edge + width → a clamped 0..1 fraction.
 * Returns null for a zero-width track (nothing to seek into). Exported so the
 * pointer→time mapping is unit-testable without a DOM.
 */
export function pointerFraction(clientX: number, left: number, width: number): number | null {
  if (width <= 0) {
    return null;
  }

  return clampFraction((clientX - left) / width);
}

/**
 * A controlled, canon-styled seek bar. Reuses the VibeMap pointer model
 * (getBoundingClientRect + setPointerCapture + clamp) for click/drag-to-seek, and
 * carries full keyboard control (←/→ = ±5s, Home/End, Space toggles playback when
 * `onTogglePlayback` is given). The thumb position is CONTENT motion driven off
 * the supplied `currentSeconds` (clock-tracked, never CSS-animated), so it is not
 * reduced-motion-gated — only the eased hover/focus transitions are (the VibeMap
 * precedent: a pointer-tracked marker has nothing for reduced-motion to suppress).
 */
export function VideoScrubber({
  currentSeconds,
  durationSeconds,
  label = "Seek",
  onSeek,
  onTogglePlayback,
}: {
  currentSeconds: number;
  durationSeconds: number;
  label?: string;
  onSeek: (seconds: number) => void;
  onTogglePlayback?: () => void;
}) {
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
        onSeek(next * durationSeconds);
      }
    },
    [durationSeconds, hasDuration, onSeek],
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
      trackRef.current?.setPointerCapture(event.pointerId);
      setDragFraction(next);
      seekToFraction(next);
    },
    [fractionFromEvent, hasDuration, seekToFraction],
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
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === " " || event.key === "Spacebar") {
        if (onTogglePlayback) {
          event.preventDefault();
          onTogglePlayback();
        }

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
        onSeek(next);
      }
    },
    [currentSeconds, durationSeconds, hasDuration, onSeek, onTogglePlayback],
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

/**
 * The full mixtape set player: the R2 set master + the branded controls
 * (play/pause, the seek scrubber, a current/total readout). Resilient via
 * `useVideoStallRecovery` (a stuck load re-arms the element). `preload="metadata"`
 * so first paint is just the cover poster + the duration, never the multi-hundred-MB
 * body.
 */
export function MixtapeVideoPlayer({ logId, title }: { logId: string; title: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const src = mixtapeSetVideoUrl(logId);
  const poster = mixtapeCoverUrl(logId, "card");

  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);

  // The one clock: every UI value derives from the element's `currentTime`,
  // sampled per presented frame (requestVideoFrameCallback) while playing, with a
  // rAF fallback. timeupdate/seeked cover the paused/seek cases the frame callback
  // doesn't fire for.
  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const rvfc =
      "requestVideoFrameCallback" in video
        ? (video.requestVideoFrameCallback.bind(video) as (cb: () => void) => number)
        : null;
    const cancelRvfc =
      "cancelVideoFrameCallback" in video
        ? (video.cancelVideoFrameCallback.bind(video) as (handle: number) => void)
        : null;

    let rafId = 0;
    let frameId = 0;

    const sampleClock = () => {
      setCurrentSeconds(video.currentTime);
    };

    const schedule = () => {
      if (video.paused || video.ended) {
        return;
      }

      if (rvfc) {
        frameId = rvfc(() => {
          sampleClock();
          schedule();
        });
      } else {
        rafId = window.requestAnimationFrame(() => {
          sampleClock();
          schedule();
        });
      }
    };

    const readDuration = () => {
      setDurationSeconds(Number.isFinite(video.duration) ? video.duration : 0);
    };

    const onPlay = () => {
      setPlaying(true);
      schedule();
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);

    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("timeupdate", sampleClock);
    video.addEventListener("seeked", sampleClock);
    video.addEventListener("loadedmetadata", readDuration);
    video.addEventListener("durationchange", readDuration);

    readDuration();
    sampleClock();

    if (!video.paused) {
      setPlaying(true);
      schedule();
    }

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }

      if (frameId && cancelRvfc) {
        cancelRvfc(frameId);
      }

      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("timeupdate", sampleClock);
      video.removeEventListener("seeked", sampleClock);
      video.removeEventListener("loadedmetadata", readDuration);
      video.removeEventListener("durationchange", readDuration);
    };
  }, [src]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.paused) {
      video.play().catch(() => {
        // Autoplay/gesture rules can deny play(); the poster + control hold.
      });
    } else {
      video.pause();
    }
  }, []);

  const seek = useCallback((seconds: number) => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const max = Number.isFinite(video.duration) ? video.duration : seconds;
    video.currentTime = Math.max(0, Math.min(max, seconds));
    setCurrentSeconds(video.currentTime);
  }, []);

  // The watchdog re-arms a wedged load (a faststart MP4 that stalls before the
  // first frame). The player expects playback only once the viewer has hit play —
  // a paused set has no load to be stuck.
  const recoverStuck = useCallback(() => {
    videoRef.current?.load();
  }, []);

  useVideoStallRecovery({
    expectsPlayback: playing,
    onStall: recoverStuck,
    src,
    videoRef,
  });

  return (
    <figure className="mixtape-player">
      <video
        className="mixtape-player-media"
        playsInline
        poster={poster}
        // The set is the bare R2 master (range-streamed): metadata-only up front,
        // then the browser pulls byte ranges as it plays/seeks — never a whole-file
        // fetch of the multi-hundred-MB body.
        preload="metadata"
        ref={videoRef}
        src={src}
      >
        <track kind="captions" />
      </video>

      <div className="mixtape-player-controls">
        <Button
          aria-label={playing ? `Pause ${title}` : `Play ${title}`}
          aria-pressed={playing}
          className="mixtape-player-toggle"
          onClick={togglePlay}
          size="icon"
        >
          {playing ? (
            <PauseIcon aria-hidden="true" weight="fill" />
          ) : (
            <PlayIcon aria-hidden="true" weight="fill" />
          )}
        </Button>

        <VideoScrubber
          currentSeconds={currentSeconds}
          durationSeconds={durationSeconds}
          label={`Seek through ${title}`}
          onSeek={seek}
          onTogglePlayback={togglePlay}
        />

        <span aria-hidden="true" className="mixtape-player-time">
          {formatClock(currentSeconds)} / {formatClock(durationSeconds)}
        </span>
      </div>
    </figure>
  );
}
