import { type RefObject, useCallback, useEffect, useState } from "react";
import { useVideoStallRecovery } from "@/lib/use-video-recovery";
import { clampSeconds } from "./video-format";

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

    if (!video.paused) {
      setPlaying(true);
      schedule();
    }

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
  }, [autoPlay, src, videoRef]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.paused) {
      video.play().catch(() => {});
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
