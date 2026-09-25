import { useCallback, useEffect, useRef, useState } from "react";
import { siSpotify, siTiktok } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@fluncle/ui/components/button";
import { formatDate } from "@/lib/format";
import { artistTitleLine } from "@/lib/log-prose";
import {
  albumCoverAtSize,
  trackMedia,
  videoCrop,
  videoCropPoster,
  videoPoster,
  videoRendition,
  videoVersion,
} from "@/lib/media";
import { type Track } from "@/lib/tracks";
import {
  SMALLEST_RENDITION_WIDTH,
  stepDownRenditionWidth,
  useResponsiveWidth,
} from "@/lib/use-responsive-width";
import { useVideoStallRecovery } from "@/lib/use-video-recovery";

export function StoryView({
  active,
  muted,
  onActiveVideo,
  playing,
  track,
}: {
  active: boolean;

  muted: boolean;

  onActiveVideo?: (video: HTMLVideoElement | null) => void;

  playing: boolean;
  track: Track;
}) {
  const media = track.logId ? trackMedia(track.logId) : undefined;

  const squared = Boolean(track.videoSquaredAt);

  const version = videoVersion(track.videoSquaredAt);

  const masterVideoUrl = track.videoUrl;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const paneWidth = useResponsiveWidth(videoRef);

  const [stallDownshifts, setStallDownshifts] = useState(0);
  const renditionWidth = paneWidth ? stepDownRenditionWidth(paneWidth, stallDownshifts) : undefined;
  const [renditionFailed, setRenditionFailed] = useState(false);

  const videoUrl =
    masterVideoUrl && track.logId
      ? renditionFailed
        ? masterVideoUrl
        : renditionWidth
          ? squared
            ? videoCrop(track.logId, "portrait", renditionWidth, false, version)
            : videoRendition(track.logId, { version, width: renditionWidth })
          : undefined
      : masterVideoUrl;
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

    video.play().catch(() => {});
  }, [onMaster, renditionWidth]);

  useVideoStallRecovery({
    expectsPlayback: active && playing && Boolean(videoUrl),
    onStall: recoverStuck,
    src: videoUrl,
    videoRef,
  });

  const [posterFailed, setPosterFailed] = useState(false);

  const [framePosterFailed, setFramePosterFailed] = useState(false);
  const framePoster =
    track.logId && !framePosterFailed
      ? squared
        ? videoCropPoster(track.logId, "portrait", paneWidth, 0, version)
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
    if (active) {
      onActiveVideo?.(videoRef.current);
    }
  }, [active, onActiveVideo, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (playing) {
      video.play().catch(() => {});
    } else {
      video.pause();

      if (!active) {
        video.currentTime = 0;
      }
    }
  }, [active, playing, videoUrl]);

  const trackLine = artistTitleLine(track);

  return (
    <div className="story-view">
      {masterVideoUrl ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- the footage carries the tune and no speech, so there is nothing to caption; the track's name and artist sit beside it in text.
        <video
          aria-hidden="true"
          className="story-footage"
          muted={!active || muted}

          onError={() => {
            if (!renditionFailed && videoUrl !== masterVideoUrl) {
              setRenditionFailed(true);
            }
          }}
          playsInline
          poster={posterUrl}

          preload={active ? "auto" : "metadata"}
          ref={videoRef}
          src={videoUrl}
        />
      ) : (
        <img
          alt=""
          className="story-footage"
          onError={() => setPosterFailed(true)}
          src={posterUrl}
        />
      )}

      <div aria-hidden="true" className="story-scrim" />

      <div className="story-meta">
        {track.logId ? <span className="story-log-id">{track.logId}</span> : undefined}
        <h2 className="story-title">{track.title}</h2>
        <p className="story-artist">{track.artists.join(", ")}</p>
        <p className="story-found">
          Found{" "}
          <time className="story-found-date" dateTime={track.addedAt}>
            {formatDate(track.addedAt)}
          </time>
        </p>

        <div className="story-actions">
          <Button
            aria-label={`Listen on Spotify: ${trackLine}`}
            nativeButton={false}
            // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's label onto this anchor.
            render={<a href={track.spotifyUrl} rel="noreferrer" target="_blank" />}
            size="sm"
            tabIndex={active ? 0 : -1}
            variant="outline"
          >
            <BrandIcon icon={siSpotify} />
            Listen on Spotify
          </Button>
          {track.tiktokUrl ? (
            <Button
              aria-label={`Watch on TikTok: ${trackLine}`}
              nativeButton={false}
              // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's label onto this anchor.
              render={<a href={track.tiktokUrl} rel="noreferrer" target="_blank" />}
              size="sm"
              tabIndex={active ? 0 : -1}
              variant="outline"
            >
              <BrandIcon icon={siTiktok} />
              Watch on TikTok
            </Button>
          ) : undefined}
        </div>
      </div>
    </div>
  );
}
