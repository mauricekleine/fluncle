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
import {
  SMALLEST_RENDITION_WIDTH,
  stepDownRenditionWidth,
  useResponsiveWidth,
} from "@/lib/use-responsive-width";
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
  // 1080-wide master, once the pane is measured. Squared findings request a clean
  // portrait centre-crop off the square master at the ladder width; legacy
  // findings a plain width-ladder rendition off the portrait footage.mp4.
  const paneWidth = useResponsiveWidth(videoRef);
  // Wedge counter: each stall the watchdog reports steps the requested rendition
  // one rung DOWN the ladder (see `recoverStuck`), so a link too thin for the
  // pane-sized rung is offered a lighter one instead of a heavier one.
  const [stallDownshifts, setStallDownshifts] = useState(0);
  const renditionWidth = paneWidth ? stepDownRenditionWidth(paneWidth, stallDownshifts) : undefined;
  const [renditionFailed, setRenditionFailed] = useState(false);

  // When a rendition is coming there is NO source until the pane is measured —
  // the master is never the speculative first request. Holding it for the first
  // paint (as this surface used to) opened a range request on the heaviest object
  // we have and aborted it a tick later when the measurement landed: head-of-line
  // bytes a phone pays for and never sees, spent on the reel it just opened. The
  // poster holds the frame for that tick, which is what a poster is for. The
  // master remains the source in the two cases it is genuinely the right one: a
  // finding with no Log ID (no rendition can be derived — the master is the only
  // playable), and `renditionFailed` — a transform the edge cannot make (a >100MB
  // straggler, or any transform error). Those answer with an HTTP error, so the
  // one-shot `onError` below catches them. A STALL is not that case (see below).
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

  // One re-arm per element, spent only once the ladder has bottomed out — so a
  // dead source cannot loop `load()` forever (a `load()` fires `loadstart`, which
  // resets the watchdog's own attempt budget, so the cap has to live here).
  const rearmed = useRef(false);

  // The stall watchdog catches a STUCK load — a rendition that fires `stalled`/
  // `waiting` (or never advances `readyState`) but no `error`, so the one-shot
  // `onError` below never runs and the clip would hang on its poster.
  //
  // It does NOT bail to the raw master. A stall means the bytes are not arriving:
  // either the link is too thin for what we asked for, or the edge is still cold-
  // transcoding. The master is the HEAVIEST object we have — swapping a wedged
  // rendition for it makes a constrained link strictly worse, and the full-screen
  // reel is where the viewer is actively WAITING on the clip. So a wedge steps
  // DOWN the ladder (1080 → 720 → 480 → 360): fewer bytes, a distinct cache key
  // that may already be warm, and a soft story that plays beats a crisp one that
  // never starts. At the bottom rung there is nothing lighter left to ask for, so
  // we re-arm the load once — a cold MISS usually warms on the retry — and then
  // stand down, leaving the poster to hold the frame (the player's progress clock
  // already gates on the clip being playable, so it does not run over a freeze).
  //
  // The master fallback survives where it is actually correct: a transform that
  // genuinely cannot be derived answers with an HTTP error, the <video> fires
  // `error`, and `onError` below points at the master. That path is untouched.
  // Same recovery shape as /log's footage pane (log-footage.tsx).
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
    // The watchdog only fires while `expectsPlayback` (active && playing), so the
    // re-armed load should resume playing; a denied play() degrades to the poster.
    video.play().catch(() => {});
  }, [onMaster, renditionWidth]);

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
  //
  // The crop rides the measured `paneWidth`, never the stall-downshifted clip
  // rung: a wedged clip must not also re-fetch a poster the reel already holds.
  // (Unmeasured → the native crop, the pre-#485 behavior — the full-bleed reel
  // lands the 1080 rung on most phones anyway, so the URL rarely even changes.)
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
