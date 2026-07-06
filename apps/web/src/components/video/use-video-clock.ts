import { type RefObject, useCallback, useEffect, useState } from "react";
import { useVideoStallRecovery } from "@/lib/use-video-recovery";
import { clampSeconds } from "./video-format";

// The one-clock state machine, extracted from the three players (mixtape, clip, the
// studio editor) that each copy-pasted it. The video element's own clock is the
// SINGLE source of truth: `currentTime` is sampled per presented frame via
// `requestVideoFrameCallback` (rAF fallback) while playing, with `timeupdate`/`seeked`
// covering the paused/seek cases the frame callback doesn't fire for — the radio "one
// clock" discipline. `loadedmetadata`/`durationchange`/`resize` read the duration AND
// the intrinsic geometry (the studio crop maps onto source pixels). The stall watchdog
// re-arms a wedged faststart load while playback is expected.

/** The intrinsic geometry of the loaded rendition (source pixels), for the crop math. */
export type VideoSize = { height: number; width: number };

export type VideoClock = {
  currentSeconds: number;
  durationSeconds: number;
  playing: boolean;
  seek: (seconds: number) => void;
  seekFraction: (fraction: number) => void;
  togglePlay: () => void;
  videoSize: VideoSize;
};

// A landscape 1080p default until the element reports its real geometry — the studio
// crop starts centred against this and re-centres when the rendition loads.
const DEFAULT_VIDEO_SIZE: VideoSize = { height: 1080, width: 1920 };

export function useVideoClock({
  autoPlay,
  src,
  videoRef,
}: {
  autoPlay: boolean;
  src: string | undefined;
  videoRef: RefObject<HTMLVideoElement | null>;
}): VideoClock {
  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [videoSize, setVideoSize] = useState<VideoSize>(DEFAULT_VIDEO_SIZE);

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

    const sampleClock = () => setCurrentSeconds(video.currentTime);

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

    const readMeta = () => {
      setDurationSeconds(Number.isFinite(video.duration) ? video.duration : 0);

      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoSize({ height: video.videoHeight, width: video.videoWidth });
      }
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
    video.addEventListener("loadedmetadata", readMeta);
    video.addEventListener("durationchange", readMeta);
    video.addEventListener("resize", readMeta);

    readMeta();
    sampleClock();

    // Resume reflecting an element that's already playing on mount (a src change /
    // remount) — the mixtape "resume-if-not-paused" case.
    if (!video.paused) {
      setPlaying(true);
      schedule();
    }

    // Force-play on mount for an autoplay surface (the clip preview, mounted on the
    // operator's click). Gesture rules can deny it; the control + scrubber still hold.
    if (autoPlay) {
      video.play().catch(() => {});
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
      video.removeEventListener("loadedmetadata", readMeta);
      video.removeEventListener("durationchange", readMeta);
      video.removeEventListener("resize", readMeta);
    };
    // `autoPlay` and `videoRef` are stable per surface, so in practice `src` is the
    // only key that re-wires the machine; they're listed to satisfy the deps rule.
  }, [autoPlay, src, videoRef]);

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
  }, [videoRef]);

  const seek = useCallback(
    (seconds: number) => {
      const video = videoRef.current;

      if (!video) {
        return;
      }

      video.currentTime = clampSeconds(seconds, video.duration);
      setCurrentSeconds(video.currentTime);
    },
    [videoRef],
  );

  const seekFraction = useCallback(
    (fraction: number) => {
      const video = videoRef.current;

      if (!video || !Number.isFinite(video.duration)) {
        return;
      }

      seek(fraction * video.duration);
    },
    [seek, videoRef],
  );

  // The watchdog re-arms a wedged faststart load (a stall before the first frame)
  // while playback is expected; a paused/idle element has no load to be stuck.
  const recoverStuck = useCallback(() => {
    videoRef.current?.load();
  }, [videoRef]);

  useVideoStallRecovery({ expectsPlayback: playing, onStall: recoverStuck, src, videoRef });

  return {
    currentSeconds,
    durationSeconds,
    playing,
    seek,
    seekFraction,
    togglePlay,
    videoSize,
  };
}
