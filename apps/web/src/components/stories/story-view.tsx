import { useEffect, useRef, useState } from "react";
import { siSpotify, siTiktok } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { trackMedia } from "@/lib/media";
import { type Track } from "@/lib/tracks";

// One story: the footage (clip + poster) with a bottom scrim for legible meta
// (The Legible Sky Rule), and the finding's frame — Log ID, title, artist,
// Found date, the actions. The CLIP carries the sound: the active story hands
// its <video> up to the player, which reads the clip's clock and advances when
// it ends — so the audio is the clip's own, never a preview overlaid out of
// sync with a shorter clip.
export function StoryView({
  active,
  muted,
  onActiveVideo,
  playing,
  track,
}: {
  /** This story is the current one (drives teardown of off-screen videos). */
  active: boolean;
  /** Sound is off (not yet unlocked, or muted): the clip plays silent. */
  muted: boolean;
  /** Hand the active story's <video> to the player (its clock + its audio). */
  onActiveVideo?: (video: HTMLVideoElement | null) => void;
  /** The footage should be running (active, not held, motion allowed). */
  playing: boolean;
  track: Track;
}) {
  const media = track.logId ? trackMedia(track.logId) : undefined;
  // The stored video_url is the source of truth — the upload sets it to the
  // bundle's footage.mp4. media.ts only derives the poster/cover (no DB column).
  const videoUrl = track.videoUrl;
  const [posterFailed, setPosterFailed] = useState(false);
  const posterUrl = (!posterFailed ? media?.posterUrl : undefined) ?? track.albumImageUrl;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // The active story hands its <video> up to the player, which reads its
  // currentTime/duration as the story clock and advances when it ends.
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
      video.play().catch(() => {
        // Muted autoplay is allowed; unmuting later rides the unlock gesture.
        // A hard failure degrades to the poster frame.
      });
    } else {
      video.pause();

      if (!active) {
        video.currentTime = 0;
      }
    }
  }, [active, playing, videoUrl]);

  return (
    <div className="story-view">
      {videoUrl ? (
        <video
          aria-hidden="true"
          className="story-footage"
          muted={!active || muted}
          playsInline
          poster={posterUrl}
          // Only the active story buffers ahead. The ±1 neighbours mount (for
          // instant swipe) but fetch metadata only — without this they each
          // `preload="auto"` and pull the WHOLE clip, so a single view eagerly
          // downloads ~3 full files. The footage is faststart h264 and R2 serves
          // range requests, so a neighbour streams progressively the moment it
          // becomes active; no need to have the bytes already.
          preload={active ? "auto" : "metadata"}
          ref={videoRef}
          src={videoUrl}
        />
      ) : (
        // No footage (or none of it survived the trip): the cover holds the frame.
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
            nativeButton={false}
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
              nativeButton={false}
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
