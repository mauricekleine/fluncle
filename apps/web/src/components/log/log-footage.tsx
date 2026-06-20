import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { spotifyAlbumImageAtSize, trackMedia, videoPoster, videoRendition } from "@/lib/media";
import { usePreviewPlayer } from "@/lib/preview-player";
import { type Track } from "@/lib/tracks";
import { useInViewport } from "@/lib/use-in-viewport";
import { useResponsiveWidth } from "@/lib/use-responsive-width";

// The log page's media element: the finding's footage as ONE element of the
// archival plate (the page register), not a full-bleed reel — the cinematic
// register is the Stories dialog. Footage runs as a muted loop (gesture-gated
// under reduced motion); sound is the official preview via the shared
// preview player, same as the feed's artwork toggle.
export function LogFootage({ track }: { track: Track }) {
  const media = track.logId ? trackMedia(track.logId) : undefined;
  const masterVideoUrl = track.videoUrl;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preview = usePreviewPlayer(track.trackId);

  // Lazy gate: a clip below the fold fetches nothing (preload="none" + no
  // rendition) until the reader is about to reach it, then arms in one step.
  // The poster — a cheap edge frame — always holds the pane meanwhile.
  const nearViewport = useInViewport(videoRef);

  // Same-zone Media Transformations rendition sized to the log-page pane (a
  // thumbnail, not full-bleed — so it wants far less than the 1080 master) once
  // measured AND near the viewport; the raw master holds SSR/first paint. A
  // one-shot onError drops back to the master for any straggler the edge can't
  // transform.
  const renditionWidth = useResponsiveWidth(videoRef);
  const [renditionFailed, setRenditionFailed] = useState(false);
  const videoUrl =
    masterVideoUrl && track.logId && renditionWidth && nearViewport && !renditionFailed
      ? videoRendition(track.logId, { width: renditionWidth })
      : masterVideoUrl;

  const [posterFailed, setPosterFailed] = useState(false);
  const [framePosterFailed, setFramePosterFailed] = useState(false);
  // A cheap edge-extracted opening frame; falls back to the bundle poster, then
  // album art. The poster attribute has no error event, so an Image() probe
  // validates the frame transform.
  const framePoster = track.logId && !framePosterFailed ? videoPoster(track.logId) : undefined;
  const posterUrl =
    framePoster ??
    (!posterFailed ? media?.posterUrl : undefined) ??
    spotifyAlbumImageAtSize(track.albumImageUrl, "large");

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

  // Autoplay the muted loop only when motion is welcome AND the clip has reached
  // the viewport; under reduced motion the poster holds the frame until the
  // preview toggle (a gesture) starts it. Off-screen the poster stands in and
  // nothing decodes.
  useEffect(() => {
    const video = videoRef.current;

    if (!video || !nearViewport) {
      return;
    }

    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.play().catch(() => {
        // Autoplay denied: the poster frame stands in.
      });
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

  return (
    <figure className="log-footage">
      {masterVideoUrl ? (
        <video
          aria-hidden="true"
          className="log-footage-media"
          loop
          muted
          // One-shot fallback to the raw master if the edge rendition fails
          // (a >100MB source straggler, or any transform error).
          onError={() => {
            if (!renditionFailed && videoUrl !== masterVideoUrl) {
              setRenditionFailed(true);
            }
          }}
          playsInline
          poster={posterUrl}
          // Off-screen: fetch nothing (the poster holds the pane). Once reached,
          // metadata only — play() then streams the clip progressively (R2 +
          // faststart h264 serve range requests), no whole-file pull up front.
          preload={nearViewport ? "metadata" : "none"}
          ref={videoRef}
          src={videoUrl}
        />
      ) : (
        // No footage (or none of it survived the trip): the cover holds the frame.
        <img
          alt=""
          className="log-footage-media"
          onError={() => setPosterFailed(true)}
          src={posterUrl}
        />
      )}

      {track.previewUrl ? (
        <Button
          aria-label={preview.isActive ? "Stop the preview" : "Play the preview"}
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
