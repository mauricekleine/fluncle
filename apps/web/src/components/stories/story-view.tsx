import { SpotifyLogoIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { trackMedia } from "@/lib/media";
import { type Track } from "@/lib/tracks";

// One story: the muted-loop footage with the bundle poster, a bottom scrim
// for legible meta (The Legible Sky Rule), and the finding's frame — Log ID,
// title, artist, Found date, the Spotify action. Sound is not here: the player
// owns the single preview audio graph.
export function StoryView({
  active,
  playing,
  track,
}: {
  /** This story is the current one (drives teardown of off-screen videos). */
  active: boolean;
  /** The footage should be running (active, not held, motion allowed). */
  playing: boolean;
  track: Track;
}) {
  const media = track.logId ? trackMedia(track.logId) : undefined;
  // The conventional bundle URL first (media.ts is the source of that
  // convention); the stored video_url as fallback for rows that predate it.
  const videoSources = [media?.videoUrl, track.videoUrl].filter(
    (url, index, all): url is string => Boolean(url) && all.indexOf(url) === index,
  );
  const [videoSourceIndex, setVideoSourceIndex] = useState(0);
  const videoUrl = videoSources[videoSourceIndex];
  const [posterFailed, setPosterFailed] = useState(false);
  const posterUrl = (!posterFailed ? media?.posterUrl : undefined) ?? track.albumImageUrl;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (playing) {
      video.play().catch(() => {
        // Autoplay of a muted loop is allowed everywhere modern; if it still
        // fails we quietly degrade to the poster frame.
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
          loop
          muted
          onError={() => setVideoSourceIndex((current) => current + 1)}
          playsInline
          poster={posterUrl}
          preload="auto"
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
        <Button
          className="story-spotify"
          nativeButton={false}
          render={<a href={track.spotifyUrl} rel="noreferrer" target="_blank" />}
          size="sm"
          tabIndex={active ? 0 : -1}
          variant="outline"
        >
          <SpotifyLogoIcon aria-hidden="true" weight="fill" />
          Open on Spotify
        </Button>
      </div>
    </div>
  );
}
