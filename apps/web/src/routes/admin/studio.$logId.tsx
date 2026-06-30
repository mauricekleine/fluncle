import {
  ArrowCounterClockwiseIcon,
  GearSixIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  SparkleIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { type ClipDTO } from "@fluncle/contracts/orpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { StudioCropFrame } from "@/components/admin/studio-crop-frame";
import { StudioEnergyLane } from "@/components/admin/studio-energy-lane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatClock, VideoScrubber } from "@/components/mixtape-video-player";
import { mixtapeSetVideoUrl, mixtapeStudioEnvelopeUrl } from "@/lib/media";
import { type MixtapeDTO, mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { getMixtapeForRender } from "@/lib/server/mixtapes";
import { useVideoStallRecovery } from "@/lib/use-video-recovery";
import {
  type StudioEnvelope,
  type TimelineRegion,
  bandToWindow,
  centredCropLeftFraction,
  cropRectToXOffset,
  defaultBandAt,
  fractionToMs,
  msToFraction,
  suggestionToRegion,
  xOffsetToLeftFraction,
} from "@/lib/studio-clip";

// The Studio clip editor. One landscape set
// rendition (the `<log-id>/set.mp4` master) → many framed 9:16 footage clips. Entered
// from the "Clip this set" action on a minted mixtape row (/admin/mixtapes). A full
// AdminShell fill page, assembled from the pieces the RFC's reuse inventory names:
// the `VideoScrubber` (#208), `useVideoStallRecovery`, the radio "one clock"
// discipline (the video's rVFC mediaTime is the single source of truth), the VibeMap
// pointer model (the crop rect), and Shadcn ui/* only.

const SEEK_STEP_SECONDS = 5;
const CLIP_LENGTH_PRESETS_MS = [15_000, 30_000, 60_000] as const;
const DEFAULT_CLIP_LENGTH_MS = 15_000;
// A clip needs a real window; `create_clip` rejects out ≤ in. Guard a tiny floor.
const MIN_CLIP_MS = 1_000;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchStudioMixtape = createServerFn({ method: "GET" })
  .validator((data: { logId: string }) => data)
  .handler(async ({ data: { logId } }): Promise<MixtapeDTO> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    // Resolve by the minted coordinate (published or mid-distribute). A draft has no
    // logId, so the studio is only reachable for a clippable set — and the URL carries
    // the `XXX.F.ZZ` coordinate, never the internal UUID.
    const mixtape = await getMixtapeForRender(logId);

    if (!mixtape) {
      throw redirect({ to: "/admin/mixtapes" });
    }

    return mixtape;
  });

// The set-analysis envelope is a bare R2 object on found.fluncle.com — a DIFFERENT
// origin from www.fluncle.com with no `access-control-allow-origin`, so a browser
// fetch is CORS-blocked. We fetch it SERVER-SIDE (server-to-server, no CORS) and
// return the parsed envelope or null. A 404/non-OK is the normal "not staged yet"
// state (the editor degrades to manual in/out), never an error.
const fetchStudioEnvelope = createServerFn({ method: "GET" })
  .validator((data: { logId: string }) => data)
  .handler(async ({ data: { logId } }): Promise<StudioEnvelope | null> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    try {
      const response = await fetch(mixtapeStudioEnvelopeUrl(logId));

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as StudioEnvelope;
    } catch {
      // A network hiccup reads as "not staged yet" — the preview + manual in/out hold.
      return null;
    }
  });

export const Route = createFileRoute("/admin/studio/$logId")({
  beforeLoad: () => ensureAdmin(),
  component: StudioPage,
  loader: ({ params }) => fetchStudioMixtape({ data: { logId: params.logId } }),
});

// An active hand-pick band, as ordered in/out fractions of the set duration.
type Band = { inFraction: number; outFraction: number };

function StudioPage() {
  const mixtape = Route.useLoaderData();
  const title = mixtapeDisplayTitle(mixtape.title);
  const logId = mixtape.logId;

  return (
    <AdminShell
      current="mixtapes"
      fill
      subtitle={
        <>
          {mixtape.logId ? <span className="font-mono tabular-nums">{mixtape.logId}</span> : null}
          {mixtape.logId ? " · " : ""}
          Clip this set into framed 9:16 footage
        </>
      }
      title={`Studio: ${title}`}
    >
      {logId ? (
        <StudioEditor logId={logId} mixtapeId={mixtape.id ?? ""} title={title} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
          <p className="font-medium">No set video yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            This mixtape has no minted coordinate, so there's no set rendition to clip. Publish it,
            then stage its set video.
          </p>
          <Button nativeButton={false} render={<a href="/admin/mixtapes" />} variant="outline">
            Back to mixtapes
          </Button>
        </div>
      )}
    </AdminShell>
  );
}

function StudioEditor({
  logId,
  mixtapeId,
  title,
}: {
  logId: string;
  mixtapeId: string;
  title: string;
}) {
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const src = mixtapeSetVideoUrl(logId);
  const poster = mixtapeCoverUrl(logId, "card");

  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  // The intrinsic rendition geometry, read from the element — the crop xOffset is in
  // SOURCE pixels, so it needs the real dimensions (defaults to a 1080p landscape).
  const [videoSize, setVideoSize] = useState({ height: 1080, width: 1920 });

  const [band, setBand] = useState<Band | null>(null);
  // The framing rect starts centred (a centred top-down set crops cleanly there) and
  // re-centres when the real geometry loads, until the operator nudges it.
  const [cropLeftFraction, setCropLeftFraction] = useState(() =>
    centredCropLeftFraction(1920, 1080),
  );
  const framingTouched = useRef(false);
  const [clipLengthMs, setClipLengthMs] = useState<number>(DEFAULT_CLIP_LENGTH_MS);
  const [liveMessage, setLiveMessage] = useState("");
  const [error, setError] = useAutoNotice();
  const [notice, setNotice] = useAutoNotice();

  // ── The envelope — fetched SERVER-SIDE (the R2 object is cross-origin with no
  // CORS header; see fetchStudioEnvelope). Graceful absence: null means "not staged
  // yet" (a normal state), so no curve, no suggestions — the preview + manual in/out
  // still work, never an error.
  const { data: envelope } = useQuery<StudioEnvelope | null>({
    queryFn: () => fetchStudioEnvelope({ data: { logId } }),
    queryKey: ["admin", "studio-envelope", logId],
    retry: false,
    staleTime: 5 * 60_000,
  });

  // ── The set's existing clips (the editor reads its own set; the cross-set library
  // is Unit G). Focus-refetch ON (admin convention).
  const { data: clips } = useQuery<ClipDTO[]>({
    queryFn: () => fetchClips(mixtapeId),
    queryKey: ["admin", "clips", mixtapeId],
    refetchOnWindowFocus: true,
  });

  // The timeline length: the envelope's analysed duration when present (the curve +
  // suggestions are keyed to it), else the video's own duration. Both are the whole
  // set, so they coincide; preferring the envelope keeps the curve and the ghosts
  // aligned to the same axis.
  const durationMs = envelope?.durationMs ?? Math.round(durationSeconds * 1000);
  const currentMs = Math.round(currentSeconds * 1000);

  // ── The one clock: every UI value derives from the element's currentTime, sampled
  // per presented frame (requestVideoFrameCallback), with a rAF fallback — the radio
  // discipline (mixtape-video-player.tsx). The scrubber + lane only reflect it.
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

    const readMeta = () => {
      setDurationSeconds(Number.isFinite(video.duration) ? video.duration : 0);

      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoSize({ height: video.videoHeight, width: video.videoWidth });
      }
    };

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
    video.addEventListener("loadedmetadata", readMeta);
    video.addEventListener("durationchange", readMeta);
    video.addEventListener("resize", readMeta);

    readMeta();
    sampleClock();

    if (!video.paused) {
      setPlaying(true);
      schedule();
    }

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
      video.removeEventListener("loadedmetadata", readMeta);
      video.removeEventListener("durationchange", readMeta);
      video.removeEventListener("resize", readMeta);
    };
  }, [src]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.paused) {
      video.play().catch(() => {
        // Autoplay/gesture rules can deny play(); the poster + control hold.
      });
    } else {
      video.pause();
    }
  }, []);

  const seekSeconds = useCallback((seconds: number) => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const max = Number.isFinite(video.duration) ? video.duration : seconds;
    video.currentTime = Math.max(0, Math.min(max, seconds));
    setCurrentSeconds(video.currentTime);
  }, []);

  const seekFraction = useCallback(
    (fraction: number) => {
      seekSeconds(Math.floor(fractionToMs(fraction, durationMs) / 1000));
    },
    [durationMs, seekSeconds],
  );

  // ── Stall recovery: re-arm a wedged faststart load while playback is expected.
  const recoverStuck = useCallback(() => videoRef.current?.load(), []);
  useVideoStallRecovery({ expectsPlayback: playing, onStall: recoverStuck, src, videoRef });

  // Re-centre the framing when the real rendition geometry loads, until the operator
  // has nudged it (then it's theirs to keep).
  useEffect(() => {
    if (!framingTouched.current) {
      setCropLeftFraction(centredCropLeftFraction(videoSize.width, videoSize.height));
    }
  }, [videoSize]);

  // The operator dragged the rect — stop auto-centring and remember the choice.
  const handleCropChange = useCallback((next: number) => {
    framingTouched.current = true;
    setCropLeftFraction(next);
  }, []);

  // ── Suggestions → ghost regions (suggestion-first). Absent envelope → none.
  const suggestionRegions: TimelineRegion[] = (envelope?.suggestions ?? []).map((suggestion) =>
    suggestionToRegion(suggestion, durationMs),
  );

  const playheadFraction = msToFraction(currentMs, durationMs);

  // Drop a clip-length band at the playhead (the keyboard `M` mark + the toolbar).
  const markAtPlayhead = useCallback(() => {
    const window = defaultBandAt(currentMs, clipLengthMs, durationMs);
    setBand({
      inFraction: msToFraction(window.inMs, durationMs),
      outFraction: msToFraction(window.outMs, durationMs),
    });
    setLiveMessage(
      `Marked ${formatClock(window.inMs / 1000)} to ${formatClock(window.outMs / 1000)}`,
    );
  }, [clipLengthMs, currentMs, durationMs]);

  const setInToPlayhead = useCallback(() => {
    setBand((prev) => {
      const inFraction = playheadFraction;
      const outFraction = prev ? Math.max(prev.outFraction, inFraction) : inFraction;

      return { inFraction, outFraction };
    });
    setLiveMessage(`In point ${formatClock(currentSeconds)}`);
  }, [currentSeconds, playheadFraction]);

  const setOutToPlayhead = useCallback(() => {
    setBand((prev) => {
      const outFraction = playheadFraction;
      const inFraction = prev ? Math.min(prev.inFraction, outFraction) : outFraction;

      return { inFraction, outFraction };
    });
    setLiveMessage(`Out point ${formatClock(currentSeconds)}`);
  }, [currentSeconds, playheadFraction]);

  const acceptSuggestion = useCallback(
    (index: number) => {
      const suggestion = envelope?.suggestions[index];

      if (!suggestion) {
        return;
      }

      setBand({
        inFraction: msToFraction(suggestion.startMs, durationMs),
        outFraction: msToFraction(suggestion.startMs + suggestion.durationMs, durationMs),
      });
      seekSeconds(suggestion.anchorMs / 1000);
      setLiveMessage(`Accepted a drop at ${formatClock(suggestion.anchorMs / 1000)}`);
    },
    [durationMs, envelope, seekSeconds],
  );

  const resetFraming = useCallback(() => {
    framingTouched.current = false;
    setCropLeftFraction(centredCropLeftFraction(videoSize.width, videoSize.height));
    setLiveMessage("Framing reset to centre");
  }, [videoSize]);

  // ── Create a clip: the active band + the framing xOffset → a `create_clip` row.
  const createClip = useMutation({
    mutationFn: async () => {
      if (!band) {
        throw new Error("Mark an in and out point first.");
      }

      const window = bandToWindow(band.inFraction, band.outFraction, durationMs);

      if (window.outMs - window.inMs < MIN_CLIP_MS) {
        throw new Error("That clip is too short. Widen the in/out band.");
      }

      const xOffset = cropRectToXOffset({
        leftFraction: cropLeftFraction,
        videoHeight: videoSize.height,
        videoWidth: videoSize.width,
      });

      const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/clips`, {
        body: JSON.stringify({ inMs: window.inMs, outMs: window.outMs, xOffset }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: async () => {
      setBand(null);
      setNotice("Clip queued.");
      setLiveMessage("Clip queued.");
      await queryClient.invalidateQueries({ queryKey: ["admin", "clips", mixtapeId] });
    },
  });

  const deleteClip = useMutation({
    mutationFn: async (clipId: string) => {
      const response = await fetch(`/api/admin/clips/${encodeURIComponent(clipId)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: async () => {
      setNotice("Clip removed.");
      await queryClient.invalidateQueries({ queryKey: ["admin", "clips", mixtapeId] });
    },
  });

  // ── The keyboard loop (role="application"). Skip when typing in a field, and when
  // the scrubber already handled the key (it preventDefaults space/arrows/Home/End).
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) {
        return;
      }

      // Space + Enter ACTIVATE a focused button/link; let the control own them so a
      // shortcut never double-fires (e.g. Enter on the focused Create button already
      // creates; Enter on a Delete button must delete, not also create).
      if (
        (event.key === " " || event.key === "Spacebar" || event.key === "Enter") &&
        isActivationTarget(event.target)
      ) {
        return;
      }

      switch (event.key) {
        case " ":
        case "Spacebar":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          event.preventDefault();
          seekSeconds(currentSeconds - SEEK_STEP_SECONDS);
          setLiveMessage(
            `Playhead ${formatClock(Math.max(0, currentSeconds - SEEK_STEP_SECONDS))}`,
          );
          break;
        case "ArrowRight":
          event.preventDefault();
          seekSeconds(currentSeconds + SEEK_STEP_SECONDS);
          setLiveMessage(`Playhead ${formatClock(currentSeconds + SEEK_STEP_SECONDS)}`);
          break;
        case "[":
          event.preventDefault();
          setInToPlayhead();
          break;
        case "]":
          event.preventDefault();
          setOutToPlayhead();
          break;
        case "m":
        case "M":
          event.preventDefault();
          markAtPlayhead();
          break;
        case "Enter":
          event.preventDefault();
          createClip.mutate();
          break;
        default:
          break;
      }
    },
    [
      createClip,
      currentSeconds,
      markAtPlayhead,
      seekSeconds,
      setInToPlayhead,
      setOutToPlayhead,
      togglePlay,
    ],
  );

  const bandWindow = band ? bandToWindow(band.inFraction, band.outFraction, durationMs) : null;
  const bandValid = bandWindow !== null && bandWindow.outMs - bandWindow.inMs >= MIN_CLIP_MS;

  return (
    // role="application" so the editor's single-key shortcuts ([ ] M Enter, space,
    // arrows) reach the handler instead of being eaten by browse mode. aria-label +
    // the aria-live readout give a screen reader the context + the action feedback.
    <div
      aria-label={`Studio clip editor for ${title}`}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-5"
      onKeyDown={handleKeyDown}
      role="application"
    >
      <span aria-live="polite" className="sr-only">
        {liveMessage}
      </span>

      {/* Hero preview + the framing rect. The wrapper takes the rendition's intrinsic
          aspect so the 9:16 crop overlay maps 1:1 onto source pixels. */}
      <div className="mx-auto w-full max-w-3xl">
        <div
          className="studio-stage"
          style={{ aspectRatio: `${videoSize.width} / ${videoSize.height}` }}
        >
          <video
            className="studio-stage-media"
            playsInline
            poster={poster}
            preload="metadata"
            ref={videoRef}
            src={src}
          >
            <track kind="captions" />
          </video>
          <StudioCropFrame
            leftFraction={cropLeftFraction}
            onChange={handleCropChange}
            videoHeight={videoSize.height}
            videoWidth={videoSize.width}
          />
        </div>

        {/* Transport: play/pause, the reused scrubber, the time readout, the cog. */}
        <div className="mt-3 flex items-center gap-3">
          <Button
            aria-label={playing ? "Pause" : "Play"}
            aria-pressed={playing}
            onClick={togglePlay}
            size="icon"
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
            label={`Seek through ${title}`}
            onSeek={seekSeconds}
            onTogglePlayback={togglePlay}
          />

          <span className="studio-time shrink-0">
            {formatClock(currentSeconds)} / {formatClock(durationSeconds)}
          </span>

          <SettingsCog
            clipLengthMs={clipLengthMs}
            onClipLengthChange={setClipLengthMs}
            onResetFraming={resetFraming}
          />
        </div>

        {/* The one quiet energy lane (warm-neutral ramp). Absent envelope → just the
            rail + playhead + committed clips + the active band. */}
        <div className="mt-3">
          <StudioEnergyLane
            band={band ? { aFraction: band.inFraction, bFraction: band.outFraction } : null}
            clips={clips ?? []}
            currentMs={currentMs}
            durationMs={durationMs}
            envelope={envelope ?? undefined}
            onBandPaint={(a, b) =>
              setBand({ inFraction: Math.min(a, b), outFraction: Math.max(a, b) })
            }
            onSeekFraction={seekFraction}
            suggestions={suggestionRegions}
          />
          {!envelope ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No energy analysis staged yet. Mark in/out by hand; the lane and drop suggestions
              appear once the set is analysed.
            </p>
          ) : null}
        </div>

        {/* The clip-making toolbar. Gold lives ONLY on Create clip (the One Sun). */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={markAtPlayhead} size="sm" variant="outline">
            Mark <kbd className="studio-kbd">M</kbd>
          </Button>
          <Button onClick={setInToPlayhead} size="sm" variant="outline">
            Set in <kbd className="studio-kbd">[</kbd>
          </Button>
          <Button onClick={setOutToPlayhead} size="sm" variant="outline">
            Set out <kbd className="studio-kbd">]</kbd>
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {bandWindow
              ? `${formatClock(bandWindow.inMs / 1000)} – ${formatClock(bandWindow.outMs / 1000)}`
              : "No band yet"}
          </span>
          <Button
            className="ml-auto"
            disabled={!bandValid || createClip.isPending}
            onClick={() => createClip.mutate()}
            size="sm"
          >
            <ScissorsIcon aria-hidden="true" weight="bold" />
            Create clip <kbd className="studio-kbd studio-kbd-on-gold">⏎</kbd>
          </Button>
        </div>

        {error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p aria-live="polite" className="mt-2 text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}

        {/* Suggestion chips (suggestion-first, keyboard-reachable). */}
        {envelope && envelope.suggestions.length > 0 ? (
          <div className="mt-4">
            <Label className="flex items-center gap-1.5">
              <SparkleIcon aria-hidden="true" weight="fill" />
              Suggested drops
            </Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {envelope.suggestions.map((suggestion, index) => (
                <Button
                  key={suggestion.anchorMs}
                  onClick={() => acceptSuggestion(index)}
                  size="sm"
                  variant="outline"
                >
                  {formatClock(suggestion.anchorMs / 1000)}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {/* The set's clips so far (this set only; the cross-set library is Unit G). */}
        <div className="mt-6">
          <Label>Clips ({clips?.length ?? 0})</Label>
          {clips && clips.length > 0 ? (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {clips.map((clip) => (
                <ClipRow
                  key={clip.id}
                  clip={clip}
                  deleting={deleteClip.isPending && deleteClip.variables === clip.id}
                  onDelete={() => deleteClip.mutate(clip.id)}
                  onPreview={() => {
                    seekSeconds(clip.inMs / 1000);
                    setBand({
                      inFraction: msToFraction(clip.inMs, durationMs),
                      outFraction: msToFraction(clip.outMs, durationMs),
                    });
                    handleCropChange(
                      xOffsetToLeftFraction({ videoWidth: videoSize.width, xOffset: clip.xOffset }),
                    );
                  }}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              No clips yet. Mark a window and create one; a session mints many.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ClipRow({
  clip,
  deleting,
  onDelete,
  onPreview,
}: {
  clip: ClipDTO;
  deleting: boolean;
  onDelete: () => void;
  onPreview: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <button
        className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onPreview}
        type="button"
      >
        <span className="text-sm tabular-nums">
          {formatClock(clip.inMs / 1000)} – {formatClock(clip.outMs / 1000)}
        </span>
      </button>
      <Badge variant={clip.status === "done" ? "default" : "outline"}>{clip.status}</Badge>
      <Button
        aria-label="Delete clip"
        disabled={deleting}
        onClick={onDelete}
        size="icon-sm"
        variant="ghost"
      >
        <TrashIcon aria-hidden="true" />
      </Button>
    </li>
  );
}

function SettingsCog({
  clipLengthMs,
  onClipLengthChange,
  onResetFraming,
}: {
  clipLengthMs: number;
  onClipLengthChange: (ms: number) => void;
  onResetFraming: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button aria-label="Editor settings" size="icon" variant="ghost">
            <GearSixIcon aria-hidden="true" />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-64 space-y-4">
        <div className="space-y-1.5">
          <Label>Clip length</Label>
          <div className="flex gap-1.5">
            {CLIP_LENGTH_PRESETS_MS.map((ms) => (
              <Button
                key={ms}
                className="flex-1"
                onClick={() => onClipLengthChange(ms)}
                size="sm"
                variant={clipLengthMs === ms ? "secondary" : "outline"}
              >
                {ms / 1000}s
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">The window a Mark drops at the playhead.</p>
        </div>

        <Button className="w-full" onClick={onResetFraming} size="sm" variant="outline">
          <ArrowCounterClockwiseIcon aria-hidden="true" />
          Reset framing
        </Button>
      </PopoverContent>
    </Popover>
  );
}

// ── small shared bits ─────────────────────────────────────────────────────────

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName;

  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
  );
}

// Does this key target ACTIVATE on Space/Enter on its own (a button or link)? If so
// the global shortcut handler lets the control own those keys, so a shortcut never
// double-fires alongside the control's native activation.
function isActivationTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("a, button, [role='button']") !== null;
}

async function fetchClips(mixtapeId: string): Promise<ClipDTO[]> {
  const response = await fetch(`/api/admin/clips?mixtapeId=${encodeURIComponent(mixtapeId)}`);

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const body = (await response.json()) as { clips?: ClipDTO[] };

  return body.clips ?? [];
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: unknown };

    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // Fall through to text/status below.
  }

  const text = await response.text().catch(() => "");

  return text.trim() || response.statusText || `Request failed (${response.status})`;
}

function useAutoNotice(): readonly [
  string | undefined,
  Dispatch<SetStateAction<string | undefined>>,
] {
  const [value, setValue] = useState<string>();

  useEffect(() => {
    if (!value) {
      return;
    }

    const timer = window.setTimeout(() => setValue(undefined), 5000);

    return () => window.clearTimeout(timer);
  }, [value]);

  return [value, setValue] as const;
}
