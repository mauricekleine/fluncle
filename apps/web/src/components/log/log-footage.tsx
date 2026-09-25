import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  type CropOrientation,
  type RenditionWidth,
  albumCoverAtSize,
  trackMedia,
  videoCrop,
  videoCropPoster,
  videoPoster,
  videoRendition,
  videoVersion,
} from "@/lib/media";
import { toQueueTrack } from "@/lib/player-tracks";
import { usePreviewPlayer } from "@/lib/preview-player";
import { type Track } from "@/lib/tracks";
import { useInViewport } from "@/lib/use-in-viewport";
import { DESKTOP_QUERY, useMediaQuery } from "@/lib/use-media-query";
import {
  SMALLEST_RENDITION_WIDTH,
  stepDownRenditionWidth,
  useResponsiveWidth,
} from "@/lib/use-responsive-width";
import { useVideoStallRecovery } from "@/lib/use-video-recovery";

const PANE_CEILING_WIDTH: Record<CropOrientation, RenditionWidth> = {
  landscape: 1080,
  portrait: 720,
};

const FIRST_PAINT_POSTER_WIDTH = stepDownRenditionWidth(PANE_CEILING_WIDTH.portrait, 1);

export function firstPaintFootagePoster(track: Track): string | undefined {
  if (!track.logId || !track.videoUrl) {
    return undefined;
  }

  const version = videoVersion(track.videoSquaredAt);

  return track.videoSquaredAt
    ? videoCropPoster(track.logId, "portrait", FIRST_PAINT_POSTER_WIDTH, 0, version)
    : videoPoster(track.logId, undefined, version);
}

export function LogFootage({ track }: { track: Track }) {
  const media = track.logId ? trackMedia(track.logId) : undefined;
  const masterVideoUrl = track.videoUrl;

  const squared = Boolean(track.videoSquaredAt);

  const version = videoVersion(track.videoSquaredAt);

  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const queued = useMemo(() => toQueueTrack(track), [track]);
  const preview = usePreviewPlayer(track.trackId, { publicPreview: true, track: queued });

  const nearViewport = useInViewport(videoRef);

  const orientation = isDesktop ? "landscape" : "portrait";

  const paneWidth = useResponsiveWidth(videoRef);

  const [stallDownshifts, setStallDownshifts] = useState(0);
  const renditionWidth = paneWidth ? stepDownRenditionWidth(paneWidth, stallDownshifts) : undefined;
  const [renditionFailed, setRenditionFailed] = useState(false);

  const videoUrl =
    masterVideoUrl && track.logId && nearViewport
      ? renditionFailed
        ? masterVideoUrl
        : renditionWidth
          ? squared
            ? videoCrop(track.logId, orientation, renditionWidth, false, version)
            : videoRendition(track.logId, { version, width: renditionWidth })
          : undefined
      : undefined;
  const onMaster = videoUrl === masterVideoUrl;

  const rearmed = useRef(false);

  const recoverStuck = useCallback(() => {
    const video = videoRef.current;
    const canStepDown =
      !onMaster && renditionWidth !== undefined && renditionWidth > SMALLEST_RENDITION_WIDTH;

    if (canStepDown) {
      setStallDownshifts((steps) => steps + 1);

      return;
    }

    if (!video || rearmed.current) {
      return;
    }

    rearmed.current = true;
    video.load();

    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.play().catch(() => {});
    }
  }, [onMaster, renditionWidth]);

  const [posterFailed, setPosterFailed] = useState(false);
  const [framePosterFailed, setFramePosterFailed] = useState(false);

  const posterWidth = stepDownRenditionWidth(paneWidth ?? PANE_CEILING_WIDTH[orientation], 1);
  const framePoster =
    track.logId && !framePosterFailed
      ? squared
        ? videoCropPoster(track.logId, orientation, posterWidth, 0, version)
        : videoPoster(track.logId, undefined, version)
      : undefined;
  const posterUrl =
    framePoster ??
    (!posterFailed ? media?.posterUrl : undefined) ??
    albumCoverAtSize(track.albumImageUrl, "large");

  useEffect(() => {
    if (!framePoster) {
      return;
    }

    const probe = new Image();
    probe.onerror = () => setFramePosterFailed(true);
    probe.src = framePoster;

    return () => {
      probe.onerror = null;
    };
  }, [framePoster]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !nearViewport) {
      return;
    }

    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.play().catch(() => {});
    }
  }, [nearViewport, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    if (preview.isActive) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [preview.isActive]);

  const playbackExpected =
    nearViewport &&
    Boolean(videoUrl) &&
    (typeof window === "undefined" ||
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      preview.isActive);

  useVideoStallRecovery({
    expectsPlayback: playbackExpected,
    onStall: recoverStuck,
    src: videoUrl,
    videoRef,
  });

  return (
    <figure className="log-footage">
      {masterVideoUrl ? (
        <video
          aria-hidden="true"
          className={squared ? "log-footage-media log-footage-media--squared" : "log-footage-media"}
          loop
          muted

          onError={() => {
            if (!renditionFailed && videoUrl !== masterVideoUrl) {
              setRenditionFailed(true);
            }
          }}
          playsInline
          poster={posterUrl}

          preload={nearViewport ? "metadata" : "none"}
          ref={videoRef}
          src={videoUrl}

          tabIndex={-1}
        />
      ) : (
        <img
          alt=""
          className="log-footage-media"
          decoding="async"
          fetchPriority="high"
          onError={() => setPosterFailed(true)}
          src={posterUrl}
        />
      )}

      {track.previewUrl ? (
        <Button
          aria-label={preview.isActive ? "Pause the preview" : "Play the preview"}
          aria-pressed={preview.isActive}
          className="log-footage-preview"
          onClick={preview.toggle}
          size="icon"
          variant="outline"
        >
          {preview.isActive ? (
            <PauseIcon aria-hidden="true" weight="fill" />
          ) : (
            <PlayIcon aria-hidden="true" weight="fill" />
          )}
        </Button>
      ) : undefined}
    </figure>
  );
}
