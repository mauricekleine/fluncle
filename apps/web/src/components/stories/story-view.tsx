import { useCallback, useEffect, useRef, useState } from "react";
import { siSpotify, siTiktok } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@fluncle/ui/components/button";
import { formatDate } from "@/lib/format";
import {
  spotifyAlbumImageAtSize,
  trackMedia,
  videoCrop,
  videoCropPoster,
  videoPoster,
  videoRendition,
  videoVersion,
} from "@/lib/media";
import { type Track } from "@/lib/tracks";
import { useResponsiveWidth } from "@/lib/use-responsive-width";
import { useVideoStallRecovery } from "@/lib/use-video-recovery";

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
  // Stories renders the finding's frame (Log ID, title, artist) over the video in
  // the DOM, so it must NOT also burn the baked-text social cut underneath — that
  // doubles the text. Under the two-master layout (videoSquaredAt set) footage.mp4
  // is the CLEAN square master, so Stories requests an MT centre-crop to portrait
  // off it — the same clean crop /log + radio play, sized to the pane. A legacy
  // finding (no signal) has no clean square; it keeps playing its old footage.mp4
  // portrait+text cut (with the baked text), so un-migrated tracks are unchanged.
  const squared = Boolean(track.videoSquaredAt);
  // The video vintage rides every transform URL as its `?v` token: a re-render
  // bumps videoSquaredAt, so the URLs change and MT derives off the NEW master
  // (its internal output cache is not purgeable — media.ts).
  const version = videoVersion(track.videoSquaredAt);
  // Both layouts use footage.mp4 as the master: squared findings centre-crop it
  // to portrait; legacy findings play it as-is (its old portrait+text cut). It is
  // also the onError fallback the <video> re-points at if the edge transform fails.
  const masterVideoUrl = track.videoUrl;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Play a same-zone Media Transformations rendition sized to the pane, not the
  // 1080-wide master, once the pane is measured (undefined on the server / first
  // paint, where we hold the master). A one-shot onError drops back to the raw
  // master, so a straggler above Cloudflare's 100MB source ceiling — or any edge
  // error — still plays. Squared findings request a clean portrait centre-crop
  // off the square master at the same ladder width; legacy findings a plain
  // width-ladder rendition off the portrait footage.mp4.
  const renditionWidth = useResponsiveWidth(videoRef);
  const [renditionFailed, setRenditionFailed] = useState(false);
  const videoUrl =
    masterVideoUrl && track.logId && renditionWidth && !renditionFailed
      ? squared
        ? videoCrop(track.logId, "portrait", renditionWidth, false, version)
        : videoRendition(track.logId, { version, width: renditionWidth })
      : masterVideoUrl;
  const onMaster = !videoUrl || videoUrl === masterVideoUrl;

  // The stall watchdog catches a STUCK load — a rendition that fires `stalled`/
  // `waiting` (or never advances `readyState`) but no `error`, so the one-shot
  // `onError` below never runs and the clip would hang on its poster. First wedge
  // retries the same source (a cold-MISS often warms on a re-load); a wedge while
  // already on the master falls all the way back so playback still recovers.
  const recoverStuck = useCallback(() => {
    const video = videoRef.current;

    if (!renditionFailed && !onMaster) {
      // Drop the rendition for the raw master (mirrors the onError fallback).
      setRenditionFailed(true);

      return;
    }

    // Already on the master (or the rendition already gave up): re-arm the load.
    if (video) {
      video.load();
      video.play().catch(() => {});
    }
  }, [onMaster, renditionFailed]);

  useVideoStallRecovery({
    expectsPlayback: active && playing && Boolean(videoUrl),
    onStall: recoverStuck,
    src: videoUrl,
    videoRef,
  });

  const [posterFailed, setPosterFailed] = useState(false);
  // A cheap edge-extracted opening frame for the poster; falls back to the
  // bundle's poster.jpg, then the album art, as each upstream fails. The
  // <video> poster attribute has no error event, so an Image() probe validates
  // the frame transform and flips to the bundle poster if the edge can't make
  // it (e.g. a >100MB source straggler). For squared findings the frame is
  // portrait-cropped to match the cropped clip (Cloudflare MT accepts
  // fit=cover + mode=frame); legacy findings take the plain opening frame.
  const [framePosterFailed, setFramePosterFailed] = useState(false);
  const framePoster =
    track.logId && !framePosterFailed
      ? squared
        ? videoCropPoster(track.logId, "portrait", renditionWidth, 0, version)
        : videoPoster(track.logId, undefined, version)
      : undefined;
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
      {masterVideoUrl ? (
        <video
          aria-hidden="true"
          className="story-footage"
          muted={!active || muted}
          // A one-shot fallback: if the edge rendition can't be made (a source
          // over Cloudflare's 100MB ceiling, or any transform error) the element
          // re-points at the raw master and plays that instead.
          onError={() => {
            if (!renditionFailed && videoUrl !== masterVideoUrl) {
              setRenditionFailed(true);
            }
          }}
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
