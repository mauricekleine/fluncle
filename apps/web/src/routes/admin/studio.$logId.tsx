import {
  ArrowCounterClockwiseIcon,
  GearSixIcon,
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
import { StudioCueRail } from "@/components/admin/studio-cue-rail";
import { StudioEnergyLane } from "@/components/admin/studio-energy-lane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { formatClock, useVideo, Video } from "@/components/video";
import { mixtapeSetVideoUrl, mixtapeStudioEnvelopeUrl } from "@/lib/media";
import { type MixtapeDTO, mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { getMixtapeForRender } from "@/lib/server/mixtapes";
import {
  type StudioEnvelope,
  type TimelineRegion,
  bandToWindow,
  centredCropLeftFraction,
  cropRectToXOffset,
  cueProgress,
  defaultBandAt,
  fractionToMs,
  msToFraction,
  snapCueToPeak,
  suggestionToRegion,
  xOffsetToLeftFraction,
} from "@/lib/studio-clip";

// The Studio clip editor. One landscape set
// rendition (the `<log-id>/set.mp4` master) → many framed 9:16 footage clips. Entered
// from the "Clip this set" action on a minted mixtape row (/admin/mixtapes). A full
// AdminShell fill page composed from the shared `<Video>` compound (Root owns the "one
// clock" machine + stall recovery; the scrubber + transport read it) plus the editor's
// own chrome — the VibeMap-pointer crop rect and the energy lane — over the same
// element, with Shadcn ui/* only.

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
        <StudioEditor
          initialMixtape={mixtape}
          logId={logId}
          mixtapeId={mixtape.id ?? ""}
          title={title}
        />
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

// The outer shell mounts `Video.Root` (the "one clock" state machine + stall recovery)
// so the editor body can read the machine through context. The body holds the
// studio-specific state (the in/out band, the framing rect, suggestions, the keyboard
// loop) and the chrome (the crop frame, the energy lane, the toolbar).
function StudioEditor({
  initialMixtape,
  logId,
  mixtapeId,
  title,
}: {
  initialMixtape: MixtapeDTO;
  logId: string;
  mixtapeId: string;
  title: string;
}) {
  const src = mixtapeSetVideoUrl(logId);
  const poster = mixtapeCoverUrl(logId, "card");

  return (
    <Video.Root src={src}>
      <StudioEditorBody
        initialMixtape={initialMixtape}
        logId={logId}
        mixtapeId={mixtapeId}
        poster={poster}
        title={title}
      />
    </Video.Root>
  );
}

function StudioEditorBody({
  initialMixtape,
  logId,
  mixtapeId,
  poster,
  title,
}: {
  initialMixtape: MixtapeDTO;
  logId: string;
  mixtapeId: string;
  poster: string;
  title: string;
}) {
  const queryClient = useQueryClient();
  // The one clock + element geometry come from Video.Root; the crop xOffset is in SOURCE
  // pixels, so it needs `videoSize` (a 1080p landscape default until the rendition
  // reports its real dimensions).
  const { currentSeconds, durationSeconds, seek, togglePlay, videoSize } = useVideo();

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
  // The cue rail: which member the keyboard mark (`c`) / clear (`x`) targets, and
  // whether a mark snaps to the nearest loudness drop (an assist, toggleable in the cog).
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [snapCues, setSnapCues] = useState(true);

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

  // ── The mixtape itself (its ordered members carry each cue's start_ms). Seeded from
  // the loader so there's no flash, then kept live: focus-refetch ON (admin
  // convention), and each cue write updates it optimistically via setQueryData.
  const cueQueryKey = ["admin", "studio-mixtape", logId] as const;
  const { data: mixtape } = useQuery<MixtapeDTO>({
    initialData: initialMixtape,
    queryFn: () => fetchStudioMixtape({ data: { logId } }),
    queryKey: cueQueryKey,
    refetchOnWindowFocus: true,
  });
  const members = mixtape.members;

  // The timeline length: the envelope's analysed duration when present (the curve +
  // suggestions are keyed to it), else the video's own duration. Both are the whole
  // set, so they coincide; preferring the envelope keeps the curve and the ghosts
  // aligned to the same axis.
  const durationMs = envelope?.durationMs ?? Math.round(durationSeconds * 1000);
  const currentMs = Math.round(currentSeconds * 1000);

  // The lane seeks against the envelope's analysed duration (the curve + suggestions
  // are keyed to it), not the video's own — they coincide, but this keeps the ghosts on
  // the same axis. The compound's `seek` (seconds) is the one mutation of the clock.
  const seekFraction = useCallback(
    (fraction: number) => {
      seek(Math.floor(fractionToMs(fraction, durationMs) / 1000));
    },
    [durationMs, seek],
  );

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
      seek(suggestion.anchorMs / 1000);
      setLiveMessage(`Accepted a drop at ${formatClock(suggestion.anchorMs / 1000)}`);
    },
    [durationMs, envelope, seek],
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

  // ── Cue one member (set/clear its start_ms) via `update_mixtape_cue`. Each mark saves
  // instantly, with an optimistic setQueryData so the rail + lane update before the round
  // trip; a failure rolls back to the snapshot. `startMs: null` clears the cue.
  const setCue = useMutation<
    void,
    Error,
    { ref: string; startMs: number | null },
    { previous: MixtapeDTO | undefined }
  >({
    mutationFn: async ({ ref, startMs }) => {
      const response = await fetch(
        `/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/cues/${encodeURIComponent(ref)}`,
        {
          body: JSON.stringify({ startMs }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        },
      );

      if (!response.ok) {
        throw new Error(await readError(response));
      }
    },
    onError: (caught, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(cueQueryKey, context.previous);
      }

      setError(caught instanceof Error ? caught.message : String(caught));
    },
    onMutate: async ({ ref, startMs }) => {
      await queryClient.cancelQueries({ queryKey: cueQueryKey });
      const previous = queryClient.getQueryData<MixtapeDTO>(cueQueryKey);

      queryClient.setQueryData<MixtapeDTO>(cueQueryKey, (old) =>
        old
          ? {
              ...old,
              members: old.members.map((member) =>
                member.trackId === ref ? { ...member, startMs: startMs ?? undefined } : member,
              ),
            }
          : old,
      );

      return { previous };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: cueQueryKey }),
  });

  // Mark the given member at the playhead (snapped to the nearest drop when snapping is
  // on), then select it. The mark saves via the optimistic mutation above.
  const markCue = useCallback(
    (trackId: string) => {
      const snap = snapCues
        ? snapCueToPeak(currentMs, envelope?.peaks ?? [])
        : { ms: Math.max(0, currentMs), snapped: false };

      setCue.mutate({ ref: trackId, startMs: snap.ms });
      setSelectedTrackId(trackId);
      setLiveMessage(
        snap.snapped
          ? `Cued at drop ${formatClock(snap.ms / 1000)}`
          : `Cued at ${formatClock(snap.ms / 1000)}`,
      );
    },
    [currentMs, envelope, setCue, snapCues],
  );

  const clearCue = useCallback(
    (trackId: string) => {
      setCue.mutate({ ref: trackId, startMs: null });
      setLiveMessage("Cue cleared");
    },
    [setCue],
  );

  // Move the cue-rail selection (the ↑/↓ keyboard target), clamped to the tracklist.
  const moveSelection = useCallback(
    (delta: number) => {
      if (members.length === 0) {
        return;
      }

      const currentIndex = members.findIndex((member) => member.trackId === selectedTrackId);
      const baseIndex = currentIndex === -1 ? 0 : currentIndex;
      const next = members[Math.max(0, Math.min(members.length - 1, baseIndex + delta))];

      if (next) {
        setSelectedTrackId(next.trackId);
        setLiveMessage(`Selected ${next.artists.join(", ")} — ${next.title}`);
      }
    },
    [members, selectedTrackId],
  );

  // Default the selection to the first member once the tracklist is known.
  useEffect(() => {
    if (selectedTrackId === null && members.length > 0) {
      setSelectedTrackId(members[0]?.trackId ?? null);
    }
  }, [members, selectedTrackId]);

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
          seek(currentSeconds - SEEK_STEP_SECONDS);
          setLiveMessage(
            `Playhead ${formatClock(Math.max(0, currentSeconds - SEEK_STEP_SECONDS))}`,
          );
          break;
        case "ArrowRight":
          event.preventDefault();
          seek(currentSeconds + SEEK_STEP_SECONDS);
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
        case "ArrowUp":
          event.preventDefault();
          moveSelection(-1);
          break;
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1);
          break;
        case "c":
        case "C":
          event.preventDefault();
          if (selectedTrackId) {
            markCue(selectedTrackId);
          }
          break;
        case "x":
        case "X":
          event.preventDefault();
          if (selectedTrackId) {
            clearCue(selectedTrackId);
          }
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
      clearCue,
      createClip,
      currentSeconds,
      markAtPlayhead,
      markCue,
      moveSelection,
      seek,
      selectedTrackId,
      setInToPlayhead,
      setOutToPlayhead,
      togglePlay,
    ],
  );

  const bandWindow = band ? bandToWindow(band.inFraction, band.outFraction, durationMs) : null;
  const bandValid = bandWindow !== null && bandWindow.outMs - bandWindow.inMs >= MIN_CLIP_MS;

  // The cue pins the lane draws: one per marked member, reddened when out of order.
  const cueOutOfOrder = new Set(cueProgress(members).outOfOrderTrackIds);
  const cueTicks = members
    .filter((member) => member.startMs != null)
    .map((member) => ({
      outOfOrder: cueOutOfOrder.has(member.trackId),
      startMs: member.startMs ?? 0,
      trackId: member.trackId,
    }));
  // The trackId whose cue write is currently in flight (per-row saving indicator).
  const savingCueTrackId = setCue.isPending ? (setCue.variables?.ref ?? null) : null;

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
        <Video.Surface
          className="studio-stage"
          mediaClassName="studio-stage-media"
          poster={poster}
          style={{ aspectRatio: `${videoSize.width} / ${videoSize.height}` }}
        >
          <StudioCropFrame
            leftFraction={cropLeftFraction}
            onChange={handleCropChange}
            videoHeight={videoSize.height}
            videoWidth={videoSize.width}
          />
        </Video.Surface>

        {/* Transport: play/pause, the shared scrubber, the time readout, the cog. */}
        <div className="mt-3 flex items-center gap-3">
          <Video.PlayButton />
          <Video.Scrubber label={`Seek through ${title}`} />
          <Video.Time className="studio-time shrink-0" />

          <SettingsCog
            clipLengthMs={clipLengthMs}
            onClipLengthChange={setClipLengthMs}
            onResetFraming={resetFraming}
            onSnapCuesChange={setSnapCues}
            snapCues={snapCues}
          />
        </div>

        {/* The one quiet energy lane (warm-neutral ramp). Absent envelope → just the
            rail + playhead + committed clips + the active band. */}
        <div className="mt-3">
          <StudioEnergyLane
            band={band ? { aFraction: band.inFraction, bFraction: band.outFraction } : null}
            clips={clips ?? []}
            cues={cueTicks}
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

        {/* The cue rail — mark each track's start in the set. The times feed YouTube
            chapters, the /log per-track times, and (later) clip auto-crediting. */}
        <StudioCueRail
          members={members}
          onClear={clearCue}
          onMark={markCue}
          onSeek={(ms) => seek(ms / 1000)}
          onSelect={setSelectedTrackId}
          savingTrackId={savingCueTrackId}
          selectedTrackId={selectedTrackId}
        />

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
                    seek(clip.inMs / 1000);
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
  onSnapCuesChange,
  snapCues,
}: {
  clipLengthMs: number;
  onClipLengthChange: (ms: number) => void;
  onResetFraming: () => void;
  onSnapCuesChange: (snap: boolean) => void;
  snapCues: boolean;
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

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="studio-snap-cues">Snap cues to drops</Label>
            <Switch
              checked={snapCues}
              id="studio-snap-cues"
              onCheckedChange={(checked) => onSnapCuesChange(checked)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            A cue mark jumps to the nearest loudness drop. Off marks the exact playhead.
          </p>
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
