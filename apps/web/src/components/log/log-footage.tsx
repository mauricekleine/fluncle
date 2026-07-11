import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  type CropOrientation,
  type RenditionWidth,
  spotifyAlbumImageAtSize,
  trackMedia,
  videoCrop,
  videoCropPoster,
  videoPoster,
  videoRendition,
  videoVersion,
} from "@/lib/media";
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

// The ladder rung the pane lands on BEFORE it has been measured — the poster's
// width, since the poster is fetched at first paint and cannot wait for a
// ResizeObserver. Both rungs are read straight off the pane's CSS (styles.css,
// `.log-footage`): mobile is `min(100%, 19rem)` = at most 304 CSS px, so even a 3×
// phone (the ratio is capped at 2×) needs only 608 device px → the 720 rung, which
// is exactly where the measurement lands; desktop's landscape pane takes the
// column's full width, so it starts at the native rung.
const PANE_CEILING_WIDTH: Record<CropOrientation, RenditionWidth> = {
  landscape: 1080,
  portrait: 720,
};

// The log page's media element: the finding's footage as ONE element of the
// archival plate (the page register), not a full-bleed reel — the cinematic
// register is the Stories dialog. Footage runs as a muted loop (gesture-gated
// under reduced motion); sound is the official preview via the shared
// preview player, same as the feed's artwork toggle.
export function LogFootage({ track }: { track: Track }) {
  const media = track.logId ? trackMedia(track.logId) : undefined;
  const masterVideoUrl = track.videoUrl;
  // The /log page owns its chrome (Log ID, prose, metadata), so it plays the
  // CLEAN footage, not the baked-text social cut. Under the two-master layout
  // (videoSquaredAt set) footage.mp4 is the clean square master, so /log requests
  // an MT centre-crop to the pane the viewport wants: a 16:9 landscape on desktop
  // (the deliberate "show off the asset" moment) and a 9:16 portrait on mobile.
  // A legacy finding (no signal) keeps playing footage.mp4 as today's
  // portrait+text cut. NEVER footage.social.mp4 — that
  // baked-text cut is the homepage Stories format; /log + radio stay clean.
  const squared = Boolean(track.videoSquaredAt);
  // The video vintage rides every transform URL as its `?v` token — a re-render
  // bumps videoSquaredAt, so MT derives off the new master (media.ts).
  const version = videoVersion(track.videoSquaredAt);
  // The desktop verdict drives BOTH the requested crop and the pane aspect (the
  // `--squared` class flips 9:16 → 16:9 at the same min-width: 768px boundary).
  // `false` until mounted, so SSR/first paint is the mobile-first portrait pane.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preview = usePreviewPlayer(track.trackId);

  // Lazy gate: a clip below the fold fetches nothing (preload="none" + no
  // rendition) until the reader is about to reach it, then arms in one step.
  // The poster — a cheap edge frame — always holds the pane meanwhile.
  const nearViewport = useInViewport(videoRef);

  const orientation = isDesktop ? "landscape" : "portrait";

  // Same-zone Media Transformations rendition sized to the log-page pane, the way
  // Stories already sizes its crop. The pane is a PLATE element, not a full-bleed
  // reel — `.log-footage` is `min(100%, 19rem)`, so a phone paints it ~304 CSS px
  // wide and wants the 720 rung, never the native 1080×1920 crop.
  const paneWidth = useResponsiveWidth(videoRef);
  // Wedge counter: each stall the watchdog reports steps the requested rendition
  // one rung DOWN the ladder (see `recoverStuck`), so a link too thin for the
  // pane-sized rung is offered a lighter one instead of a heavier one.
  const [stallDownshifts, setStallDownshifts] = useState(0);
  const renditionWidth = paneWidth ? stepDownRenditionWidth(paneWidth, stallDownshifts) : undefined;
  const [renditionFailed, setRenditionFailed] = useState(false);

  // The rendition is the ONLY clip this page ever asks for. There is no source at
  // all until BOTH gates open — the clip is near the viewport, and the pane has
  // been measured — so the heavy master is never speculatively pulled in the frame
  // between hydration and the first measurement (it was: the browser opened a range
  // request on the square master and aborted it a tick later, head-of-line bytes a
  // phone pays for and never sees). The poster holds the pane meanwhile, which is
  // what a poster is for.
  //
  // The raw master appears in exactly one case: `renditionFailed` — a transform the
  // edge genuinely cannot derive (a >100MB source straggler, or any transform
  // error). Those answer with an HTTP error, so the one-shot `onError` below catches
  // them. A STALL is not that case, and never reaches for the master (see below).
  const videoUrl =
    masterVideoUrl && track.logId && nearViewport
      ? renditionFailed
        ? masterVideoUrl
        : renditionWidth
          ? squared
            ? // Two-master: a clean centre-crop off the square master — landscape
              // on desktop, portrait on mobile — sized to the pane, not natively.
              videoCrop(track.logId, orientation, renditionWidth, false, version)
            : // Legacy: a width-ladder rendition off the portrait footage.mp4.
              videoRendition(track.logId, { version, width: renditionWidth })
          : undefined
      : undefined;
  const onMaster = videoUrl === masterVideoUrl;

  // One re-arm per element, spent only once the ladder has bottomed out — so a
  // dead source cannot loop `load()` forever (a `load()` fires `loadstart`, which
  // resets the watchdog's own attempt budget, so the cap has to live here).
  const rearmed = useRef(false);

  // The stall watchdog catches a STUCK load (a rendition that fires `stalled`/
  // `waiting`, or never advances `readyState`, with no `error` — so the one-shot
  // `onError` below never runs).
  //
  // It does NOT bail to the raw master. A stall means the bytes are not arriving:
  // either the link is too thin for what we asked for, or the edge is still cold-
  // transcoding. The master is the HEAVIEST object we have (the full square
  // 1920×1920 cut) — swapping a wedged rendition for it makes a constrained link
  // strictly worse, which is exactly the /log-on-cellular failure this replaces.
  // So a wedge steps DOWN the ladder (720 → 480 → 360): fewer bytes, a distinct
  // cache key that may already be warm, and a soft clip that plays beats a crisp
  // one that never starts. At the bottom rung there is nothing lighter left to
  // ask for, so we re-arm the load once — a cold MISS usually warms on the retry
  // — and then stand down, leaving the poster to hold the pane.
  //
  // The master fallback survives where it is actually correct: a transform that
  // genuinely cannot be derived answers with an HTTP error, the <video> fires
  // `error`, and `onError` below points at the master. That path is untouched.
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
  // A cheap edge-extracted opening frame; falls back to the bundle poster, then
  // album art. The poster attribute has no error event, so an Image() probe
  // validates the frame transform.
  //
  // For a squared finding the frame is CROPPED to the pane's orientation, one rung
  // BELOW the clip's. Three things decide that width:
  //
  //  - It must be CROPPED. An unsized `mode=frame` off the SQUARE master lands in
  //    Cloudflare MT's degenerate no-width default (~202px — the same trap
  //    `videoAudioStripped` documents), so the poster was a ~202px square frame
  //    upscaled 3× into a 9:16 pane. Nobody chose that; it fell out of the missing
  //    width. It is also the image a reduced-motion visitor keeps looking at, since
  //    the clip never autoplays for them.
  //  - It cannot wait for the measurement — it is the one thing fetched at first
  //    paint — so it names its rung up front from the pane's CSS ceiling
  //    (PANE_CEILING_WIDTH), which is the rung the measurement lands on anyway. A
  //    phone therefore fetches ONE poster, not a native frame then a sized one.
  //  - It is a STILL under a moving clip, so it does not need the clip's density: a
  //    rung down is a third of the bytes (measured on a real finding — 720×1280 =
  //    243 KB, 480×853 = 89 KB), and those bytes are spent on exactly the thin link
  //    we are here to unblock, ahead of the clip itself.
  //
  // It rides the measured `paneWidth`, never the stall-downshifted width: a wedged
  // clip must not also re-fetch a poster the page already holds.
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

  // Watchdog: only while the clip is actually meant to be loading/playing — near
  // the viewport, and either motion is welcome (the muted loop) or the preview
  // toggle armed it under reduced motion. Off-screen there's no load to be stuck.
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
          // Decorative muted loop (no controls): kept out of the focus order so
          // it stays consistent with aria-hidden — sound is the preview button.
          tabIndex={-1}
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
