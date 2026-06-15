import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { trackMedia, videoPoster, videoRendition } from "@/lib/media";
import { usePreviewPlayer } from "@/lib/preview-player";
import { type Track } from "@/lib/tracks";
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

  // Same-zone Media Transformations rendition sized to the log-page pane (a
  // thumbnail, not full-bleed — so it wants far less than the 1080 master) once
  // measured; the raw master holds SSR/first paint. A one-shot onError drops
  // back to the master for any straggler the edge can't transform.
  const renditionWidth = useResponsiveWidth(videoRef);
  const [renditionFailed, setRenditionFailed] = useState(false);
  const videoUrl =
    masterVideoUrl && track.logId && renditionWidth && !renditionFailed
      ? videoRendition(track.logId, { width: renditionWidth })
      : masterVideoUrl;

  const [posterFailed, setPosterFailed] = useState(false);
  const [framePosterFailed, setFramePosterFailed] = useState(false);
  // A cheap edge-extracted opening frame; falls back to the bundle poster, then
  // album art. The poster attribute has no error event, so an Image() probe
  // validates the frame transform.
  const framePoster = track.logId && !framePosterFailed ? videoPoster(track.logId) : undefined;
  const posterUrl =
    framePoster ?? (!posterFailed ? media?.posterUrl : undefined) ?? track.albumImageUrl;

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

  // Autoplay the muted loop only when motion is welcome; under reduced motion
  // the poster holds the frame until the preview toggle (a gesture) starts it.
  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.play().catch(() => {
        // Autoplay denied: the poster frame stands in.
      });
    }
  }, [videoUrl]);

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
          preload="metadata"
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
