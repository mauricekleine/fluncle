import {
  DownloadSimpleIcon,
  PaperPlaneTiltIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { type ClipDTO } from "@fluncle/contracts/orpc";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatClock, VideoScrubber } from "@/components/mixtape-video-player";
import { InstagramIcon, TiktokIcon } from "@/components/platform-icons";
import { Button } from "@/components/ui/button";
import { type MixtapeDTO, mixtapeDisplayTitle } from "@/lib/mixtapes";
import {
  type ClipDownloadUrls,
  clipDownloadUrls,
  clipDurationMs,
  clipPosterUrl,
  clipPreviewUrl,
} from "@/lib/studio-clips";
import { useVideoStallRecovery } from "@/lib/use-video-recovery";

// One clip in the cross-set library grid (Fluncle Studio Unit G; docs/fluncle-studio-rfc.md
// §8). A 9:16 poster tile that reveals an inline preview (the shared VideoScrubber +
// the radio "one clock" discipline) and the hand-off: download WITH audio (Instagram)
// or audio-STRIPPED (TikTok). A `pending` clip — minted in the editor, not yet cut by
// the box — shows a quiet "cutting" state instead of a poster (no preview/download).
//
// Distribution is DEFERRED (the operator hand-posts; IG/TikTok have no API music path,
// see RFC §1): the "Distribute" affordance is a disabled seam. When push-to-social
// lands it becomes the live action here, writing `mixtape_clip_social_posts` rows.

export function ClipCard({
  clip,
  deleting,
  mixtape,
  onDelete,
}: {
  clip: ClipDTO;
  deleting: boolean;
  /** The source set, when it's in the loaded list (for the title + the back-link). */
  mixtape: MixtapeDTO | undefined;
  onDelete: () => void;
}) {
  const isDone = clip.status === "done";
  const setTitle = mixtape ? mixtapeDisplayTitle(mixtape.title) : "Unknown set";
  const lengthLabel = formatClock(clipDurationMs(clip) / 1000);
  const rangeLabel = `${formatClock(clip.inMs / 1000)} – ${formatClock(clip.outMs / 1000)}`;
  const downloads = clipDownloadUrls(clip.id);

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      {isDone ? <ClipStage clipId={clip.id} title={setTitle} /> : <CuttingStage />}

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex items-baseline justify-between gap-2">
          {mixtape?.id ? (
            <a
              className="min-w-0 truncate text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
              href={`/admin/studio/${encodeURIComponent(mixtape.id)}`}
            >
              {setTitle}
            </a>
          ) : (
            <span className="min-w-0 truncate text-sm font-medium">{setTitle}</span>
          )}
          {mixtape?.logId ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {mixtape.logId}
            </span>
          ) : null}
        </div>

        <p className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{lengthLabel}</span>
          <span aria-hidden="true">·</span>
          <span>{rangeLabel}</span>
        </p>

        {clip.caption ? (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {clip.caption}
          </p>
        ) : (
          <p className="text-xs italic text-muted-foreground/70">No caption yet.</p>
        )}

        <div className="mt-auto flex items-center gap-1.5 pt-1">
          {isDone ? (
            <ClipDownloads downloads={downloads} title={setTitle} />
          ) : (
            <span className="text-xs text-muted-foreground">Cutting…</span>
          )}

          {/* Distribution seam (deferred): push-to-social lands here, writing
              mixtape_clip_social_posts rows. A clearly-inert disabled affordance — the
              aria-label carries the meaning for AT (a tooltip on a disabled control is
              keyboard-unreachable), the native title hints for a hovering mouse. */}
          <Button
            aria-label="Distribute — lands later"
            disabled
            size="icon-sm"
            title="Pushing to a platform lands here later"
            variant="ghost"
          >
            <PaperPlaneTiltIcon aria-hidden="true" />
          </Button>

          <Button
            aria-label="Delete clip"
            className="ml-auto"
            disabled={deleting}
            onClick={onDelete}
            size="icon-sm"
            variant="ghost"
          >
            <TrashIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </article>
  );
}

// The done clip's 9:16 stage: a poster that, on play, mounts the inline preview. The
// video is only loaded once the operator actually previews (lazy — a grid of many
// clips never fetches every body).
function ClipStage({ clipId, title }: { clipId: string; title: string }) {
  const [previewing, setPreviewing] = useState(false);

  if (previewing) {
    return <ClipPreview clipId={clipId} title={title} />;
  }

  return (
    <button
      aria-label={`Preview the clip from ${title}`}
      className="clip-stage group"
      onClick={() => setPreviewing(true)}
      type="button"
    >
      <img alt="" className="clip-stage-media" loading="lazy" src={clipPosterUrl(clipId)} />
      <span aria-hidden="true" className="clip-stage-play">
        <PlayIcon weight="fill" />
      </span>
    </button>
  );
}

// A pending clip's tile: a quiet, posterless placeholder (the box hasn't cut the
// footage yet). No spinner — the cut is an async backlog beat, not a foreground load.
function CuttingStage() {
  return (
    <div className="clip-stage clip-stage-pending">
      <ScissorsIcon aria-hidden="true" className="size-6 text-muted-foreground/70" />
      <span className="text-xs text-muted-foreground">Cutting this clip…</span>
    </div>
  );
}

// The inline preview: the clip rendition over `<video>` + the shared VideoScrubber,
// driven off the element's own clock (requestVideoFrameCallback, rAF fallback) — the
// radio "one clock" discipline, the same as MixtapeVideoPlayer and the editor.
function ClipPreview({ clipId, title }: { clipId: string; title: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const src = clipPreviewUrl(clipId);

  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const rvfc =
      "requestVideoFrameCallback" in video
        ? (video.requestVideoFrameCallback.bind(video) as (cb: () => void) => number)
        : null;
    const cancelRvfc =
      "cancelVideoFrameCallback" in video
        ? (video.cancelVideoFrameCallback.bind(video) as (handle: number) => void)
        : null;

    let rafId = 0;
    let frameId = 0;

    const sampleClock = () => setCurrentSeconds(video.currentTime);

    const schedule = () => {
      if (video.paused || video.ended) {
        return;
      }

      if (rvfc) {
        frameId = rvfc(() => {
          sampleClock();
          schedule();
        });
      } else {
        rafId = window.requestAnimationFrame(() => {
          sampleClock();
          schedule();
        });
      }
    };

    const readDuration = () =>
      setDurationSeconds(Number.isFinite(video.duration) ? video.duration : 0);

    const onPlay = () => {
      setPlaying(true);
      schedule();
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);

    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("timeupdate", sampleClock);
    video.addEventListener("seeked", sampleClock);
    video.addEventListener("loadedmetadata", readDuration);
    video.addEventListener("durationchange", readDuration);

    // Mounted on the operator's click — start playing the preview immediately.
    video.play().catch(() => {
      // Autoplay/gesture rules can deny play(); the control + scrubber still hold.
    });

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }

      if (frameId && cancelRvfc) {
        cancelRvfc(frameId);
      }

      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("timeupdate", sampleClock);
      video.removeEventListener("seeked", sampleClock);
      video.removeEventListener("loadedmetadata", readDuration);
      video.removeEventListener("durationchange", readDuration);
    };
  }, [src]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.paused) {
      video.play().catch(() => {
        // Gesture rules can deny play(); the control holds.
      });
    } else {
      video.pause();
    }
  }, []);

  const seek = useCallback((seconds: number) => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const max = Number.isFinite(video.duration) ? video.duration : seconds;
    video.currentTime = Math.max(0, Math.min(max, seconds));
    setCurrentSeconds(video.currentTime);
  }, []);

  const recoverStuck = useCallback(() => videoRef.current?.load(), []);
  useVideoStallRecovery({ expectsPlayback: playing, onStall: recoverStuck, src, videoRef });

  return (
    <div className="clip-stage">
      <video
        autoPlay
        className="clip-stage-media"
        playsInline
        preload="metadata"
        ref={videoRef}
        src={src}
      >
        <track kind="captions" />
      </video>
      <div className="clip-preview-controls">
        <Button
          aria-label={playing ? "Pause" : "Play"}
          aria-pressed={playing}
          onClick={togglePlay}
          size="icon-sm"
        >
          {playing ? (
            <PauseIcon aria-hidden="true" weight="fill" />
          ) : (
            <PlayIcon aria-hidden="true" weight="fill" />
          )}
        </Button>
        <VideoScrubber
          currentSeconds={currentSeconds}
          durationSeconds={durationSeconds}
          label={`Seek through the clip from ${title}`}
          onSeek={seek}
          onTogglePlayback={togglePlay}
        />
      </div>
    </div>
  );
}

// The two hand-off downloads. Cross-origin (found.fluncle.com), so the `download`
// attribute can't force a Save dialog — the file opens in a new tab for the operator
// to save and post by hand (the irreducible in-app beat).
function ClipDownloads({ downloads, title }: { downloads: ClipDownloadUrls; title: string }) {
  return (
    <>
      <Button
        aria-label={`Download the clip from ${title} with audio, for Instagram`}
        nativeButton={false}
        render={<a download href={downloads.withAudio} rel="noopener noreferrer" target="_blank" />}
        size="sm"
        variant="outline"
      >
        <DownloadSimpleIcon aria-hidden="true" />
        <InstagramIcon className="size-3.5" />
      </Button>
      <Button
        aria-label={`Download the silent clip from ${title}, for TikTok`}
        nativeButton={false}
        render={<a download href={downloads.silent} rel="noopener noreferrer" target="_blank" />}
        size="sm"
        variant="outline"
      >
        <DownloadSimpleIcon aria-hidden="true" />
        <TiktokIcon className="size-3.5" />
      </Button>
    </>
  );
}
