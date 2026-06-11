import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { trackMedia } from "@/lib/media";
import { usePreviewPlayer } from "@/lib/preview-player";
import { type Track } from "@/lib/tracks";

// The log page's media element: the finding's footage as ONE element of the
// archival plate (the page register), not a full-bleed reel — the cinematic
// register is the Stories dialog. Footage runs as a muted loop (gesture-gated
// under reduced motion); sound is the official preview via the shared
// preview player, same as the feed's artwork toggle.
export function LogFootage({ track }: { track: Track }) {
  const media = track.logId ? trackMedia(track.logId) : undefined;
  const videoUrl = track.videoUrl;
  const [posterFailed, setPosterFailed] = useState(false);
  const posterUrl = (!posterFailed ? media?.posterUrl : undefined) ?? track.albumImageUrl;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preview = usePreviewPlayer(track.trackId);

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
      {videoUrl ? (
        <video
          aria-hidden="true"
          className="log-footage-media"
          loop
          muted
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
