import {
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  CassetteTapeIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  GearSixIcon,
  MegaphoneIcon,
  ScissorsIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type MixtapeSocialPostItem } from "@fluncle/contracts";
import {
  type ClipDTO,
  type RecordingDTO,
  type RecordingTracklistItem,
} from "@fluncle/contracts/orpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { RecordingCueRail } from "@/components/admin/recording-cue-rail";
import { StudioCropFrame } from "@/components/admin/studio-crop-frame";
import { StudioEnergyLane } from "@/components/admin/studio-energy-lane";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@fluncle/ui/components/alert-dialog";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@fluncle/ui/components/popover";
import { Switch } from "@fluncle/ui/components/switch";
import { Textarea } from "@fluncle/ui/components/textarea";
import { formatClock, useVideo, Video } from "@/components/video";
import { recordingSetVideoUrl } from "@/lib/media";
import { type MixtapeDTO } from "@/lib/mixtapes";
import {
  addCue,
  clearCue,
  editCue,
  markCue,
  type NewCue,
  recordingCueProgress,
  removeCue,
} from "@/lib/recording-cues";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { getMixtapeById } from "@/lib/server/mixtapes";
import { getRecording } from "@/lib/server/recordings";
import {
  type TimelineRegion,
  bandToWindow,
  centredCropLeftFraction,
  cropRectToXOffset,
  defaultBandAt,
  fractionToMs,
  msToFraction,
  xOffsetToLeftFraction,
} from "@/lib/studio-clip";

// The Studio clip editor, keyed on a RECORDING (RFC recording-primitive, Design B —
// Wave 3). One landscape set rendition (the recording's OWNED `r2Key` master) → many
// framed 9:16 footage clips. A recording is a captured set that is NOT (yet) a published
// mixtape: it is clippable without minting a scarce Log ID coordinate. Entered from the
// recordings index on `/admin/clips` (a CLI-created recording) or the "Clip this set"
// action on a promoted mixtape (which links to its recording's Studio).
//
// Vs. the old mixtape-keyed Studio: the preview sources the recording's owned key
// directly; clips are created against `/admin/recordings/{id}/clips`; the cue rail is the
// NET-NEW authoring editor (a recording starts with an EMPTY tracklist — the operator
// types + marks each cue, persisted as the whole `tracklistJson` array via
// `update_recording`). A raw recording degrades gracefully: no cover → a neutral poster;
// no energy envelope (recordings carry no `studio-envelope.json`) → the drop-suggestion
// lane is absent, manual in/out only; `ResyncFromCues` appears only once promoted.

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

// Resolve the recording in-process (a createServerFn calling the server helper directly,
// the pattern the clip library uses — no client fetch, no CORS). A missing recording
// bounces back to the clip library rather than 500-ing.
const fetchStudioRecording = createServerFn({ method: "GET" })
  .validator((data: { recordingId: string }) => data)
  .handler(async ({ data: { recordingId } }): Promise<RecordingDTO> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    try {
      return await getRecording(recordingId);
    } catch {
      throw redirect({ to: "/admin/clips" });
    }
  });

// Resolve the promoted mixtape in-process for the management block. The by-id read
// admits any status, so a mixtape still `distributing` (post-mint, pre-public)
// resolves; a bad id returns null (the block hides) rather than 500-ing.
const fetchStudioMixtape = createServerFn({ method: "GET" })
  .validator((data: { mixtapeId: string }) => data)
  .handler(async ({ data: { mixtapeId } }): Promise<MixtapeDTO | null> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    try {
      return await getMixtapeById(mixtapeId);
    } catch {
      return null;
    }
  });

export const Route = createFileRoute("/admin/studio/$recordingId")({
  beforeLoad: () => ensureAdmin(),
  component: StudioPage,
  loader: ({ params }) => fetchStudioRecording({ data: { recordingId: params.recordingId } }),
});

// An active hand-pick band, as ordered in/out fractions of the set duration.
type Band = { inFraction: number; outFraction: number };

function StudioPage() {
  const recording = Route.useLoaderData();
  const title = recording.title;

  return (
    <AdminShell
      current="recordings"
      fill
      // The Publish action lives in the HEADER — its own section, structurally apart from
      // the clip toolbar's gold "Create clip" deep in the body, so the One Sun never has
      // two gold actions competing in one region (RFC §8, DESIGN "The One Sun Rule"). It
      // shows only on an UN-PROMOTED take (a recording that owns a set video but hasn't
      // minted a coordinate); a plan (no video) and an already-promoted take show nothing.
      headerActions={
        recording.hasVideo && !recording.mixtapeId ? (
          <PublishAction recordingId={recording.id} />
        ) : undefined
      }
      subtitle={
        <>
          {recording.logId ? (
            <span className="font-mono tabular-nums">fluncle://{recording.logId}</span>
          ) : (
            "Un-promoted recording"
          )}
          {" · "}
          Clip this set into framed 9:16 footage
        </>
      }
      title={`Studio: ${title}`}
    >
      <StudioEditor initialRecording={recording} title={title} />
    </AdminShell>
  );
}

// The outer shell mounts `Video.Root` (the "one clock" state machine + stall recovery)
// so the editor body can read the machine through context. The preview sources the
// recording's OWNED key directly; a recording has no cover, so the poster is a neutral
// stage (no card image).
function StudioEditor({
  initialRecording,
  title,
}: {
  initialRecording: RecordingDTO;
  title: string;
}) {
  // A PLAN (a recording with no video — `r2Key` absent since the
  // plan→recording→mixtape Deploy-1) has nothing to clip yet.
  if (!initialRecording.r2Key) {
    return (
      <p className="text-sm text-muted-foreground">
        No set video yet. Upload a take before clipping.
      </p>
    );
  }

  const src = recordingSetVideoUrl(initialRecording.r2Key);

  return (
    <Video.Root src={src}>
      <StudioEditorBody initialRecording={initialRecording} title={title} />
    </Video.Root>
  );
}

function StudioEditorBody({
  initialRecording,
  title,
}: {
  initialRecording: RecordingDTO;
  title: string;
}) {
  const queryClient = useQueryClient();
  const recordingId = initialRecording.id;
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
  // The cue rail: which cue the keyboard mark (`c`) / clear (`x`) targets.
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);

  // ── The recording itself (its `tracklist` carries every authored cue). Seeded from the
  // loader so there's no flash, then kept live: focus-refetch ON (admin convention), and
  // each cue write updates it optimistically via setQueryData.
  const recordingQueryKey = ["admin", "studio-recording", recordingId] as const;
  const { data: recording } = useQuery<RecordingDTO>({
    initialData: initialRecording,
    queryFn: () => fetchStudioRecording({ data: { recordingId } }),
    queryKey: recordingQueryKey,
    refetchOnWindowFocus: true,
  });
  const tracklist = recording.tracklist;

  // ── The recording's clips. Focus-refetch ON (admin convention).
  const { data: clips } = useQuery<ClipDTO[]>({
    queryFn: () => fetchClips(recordingId),
    queryKey: ["admin", "clips", "recording", recordingId],
    refetchOnWindowFocus: true,
  });

  // No energy envelope for a recording (it carries no `studio-envelope.json`), so the
  // lane degrades to the playhead + committed clips + the active band, and there are no
  // drop suggestions. The timeline axis is the video's own duration.
  const durationMs = Math.round(durationSeconds * 1000);
  const currentMs = Math.round(currentSeconds * 1000);

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

  // Recordings have no envelope → no suggestion ghosts.
  const suggestionRegions: TimelineRegion[] = [];

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

  const resetFraming = useCallback(() => {
    framingTouched.current = false;
    setCropLeftFraction(centredCropLeftFraction(videoSize.width, videoSize.height));
    setLiveMessage("Framing reset to centre");
  }, [videoSize]);

  // ── Create a clip: the active band + the framing xOffset → a `create_clip` row on the
  // recording (`POST /admin/recordings/{id}/clips`).
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

      const response = await fetch(
        `/api/admin/recordings/${encodeURIComponent(recordingId)}/clips`,
        {
          body: JSON.stringify({ inMs: window.inMs, outMs: window.outMs, xOffset }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error(await readError(response));
      }
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: async () => {
      setBand(null);
      setNotice("Clip queued.");
      setLiveMessage("Clip queued.");
      await queryClient.invalidateQueries({
        queryKey: ["admin", "clips", "recording", recordingId],
      });
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
      await queryClient.invalidateQueries({
        queryKey: ["admin", "clips", "recording", recordingId],
      });
    },
  });

  // ── Persist the WHOLE cue tracklist via `replace_recording_cues` (the array is the unit
  // of truth). This is the FINDING-LINKED write path: each cue carries its `findingId`
  // (the honest link to canon) verbatim — no server-side text re-resolution — so a
  // promoted mixtape + every clip caption resolve to a real coordinate. Each edit computes
  // the next array locally (the pure `recording-cues` helpers), updates the cache
  // optimistically so the rail + lane move before the round trip, and a failure rolls back.
  const saveTracklist = useMutation<
    void,
    Error,
    RecordingTracklistItem[],
    { previous: RecordingDTO | undefined }
  >({
    mutationFn: async (next) => {
      const response = await fetch(
        `/api/admin/recordings/${encodeURIComponent(recordingId)}/cues`,
        {
          body: JSON.stringify({
            cues: next.map((cue, index) => ({
              artistsText: cue.artists.join(", "),
              findingId: cue.findingId,
              position: index + 1,
              startMs: cue.startMs,
              titleText: cue.title,
            })),
          }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        },
      );

      if (!response.ok) {
        throw new Error(await readError(response));
      }
    },
    onError: (caught, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(recordingQueryKey, context.previous);
      }

      setError(caught instanceof Error ? caught.message : String(caught));
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: recordingQueryKey });
      const previous = queryClient.getQueryData<RecordingDTO>(recordingQueryKey);

      queryClient.setQueryData<RecordingDTO>(recordingQueryKey, (old) =>
        old ? { ...old, tracklist: next } : old,
      );

      return { previous };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: recordingQueryKey }),
  });

  // ── Cue authoring (the net-new editor). Each handler computes the next array via a
  // pure helper and persists it.
  const addCueTrack = useCallback(
    (cue: NewCue) => {
      const id = crypto.randomUUID();
      // `addCue` carries the cue's `findingId` (a picked finding) or omits it (free text).
      saveTracklist.mutate(addCue(tracklist, cue, () => id));
      setSelectedCueId(id);
      setLiveMessage(`Added ${cue.artists.join(", ")} — ${cue.title}`);
    },
    [saveTracklist, tracklist],
  );

  const markCueTrack = useCallback(
    (id: string) => {
      saveTracklist.mutate(markCue(tracklist, id, currentMs));
      setSelectedCueId(id);
      setLiveMessage(`Cued at ${formatClock(currentMs / 1000)}`);
    },
    [currentMs, saveTracklist, tracklist],
  );

  const clearCueTrack = useCallback(
    (id: string) => {
      saveTracklist.mutate(clearCue(tracklist, id));
      setLiveMessage("Cue cleared");
    },
    [saveTracklist, tracklist],
  );

  const editCueTrack = useCallback(
    (id: string, patch: Partial<NewCue>) => {
      saveTracklist.mutate(editCue(tracklist, id, patch));
    },
    [saveTracklist, tracklist],
  );

  const removeCueTrack = useCallback(
    (id: string) => {
      saveTracklist.mutate(removeCue(tracklist, id));
      setSelectedCueId((current) => (current === id ? null : current));
      setLiveMessage("Track removed");
    },
    [saveTracklist, tracklist],
  );

  // Move the cue-rail selection (the ↑/↓ keyboard target), clamped to the tracklist.
  const moveSelection = useCallback(
    (delta: number) => {
      if (tracklist.length === 0) {
        return;
      }

      const currentIndex = tracklist.findIndex((cue) => cue.id === selectedCueId);
      const baseIndex = currentIndex === -1 ? 0 : currentIndex;
      const next = tracklist[Math.max(0, Math.min(tracklist.length - 1, baseIndex + delta))];

      if (next) {
        setSelectedCueId(next.id);
        setLiveMessage(`Selected ${next.artists.join(", ")} — ${next.title}`);
      }
    },
    [selectedCueId, tracklist],
  );

  // Default the selection to the first cue once the tracklist is known.
  useEffect(() => {
    if (selectedCueId === null && tracklist.length > 0) {
      setSelectedCueId(tracklist[0]?.id ?? null);
    }
  }, [selectedCueId, tracklist]);

  // ── The keyboard loop (role="application"). Skip when typing in a field, and when
  // the scrubber already handled the key (it preventDefaults space/arrows/Home/End).
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) {
        return;
      }

      // Space + Enter ACTIVATE a focused button/link; let the control own them so a
      // shortcut never double-fires.
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
          if (selectedCueId) {
            markCueTrack(selectedCueId);
          }
          break;
        case "x":
        case "X":
          event.preventDefault();
          if (selectedCueId) {
            clearCueTrack(selectedCueId);
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
      clearCueTrack,
      createClip,
      currentSeconds,
      markAtPlayhead,
      markCueTrack,
      moveSelection,
      seek,
      selectedCueId,
      setInToPlayhead,
      setOutToPlayhead,
      togglePlay,
    ],
  );

  const bandWindow = band ? bandToWindow(band.inFraction, band.outFraction, durationMs) : null;
  const bandValid = bandWindow !== null && bandWindow.outMs - bandWindow.inMs >= MIN_CLIP_MS;

  // The cue pins the lane draws: one per marked cue.
  const cueTicks = tracklist
    .filter((cue) => cue.startMs != null)
    .map((cue) => ({ outOfOrder: false, startMs: cue.startMs ?? 0, trackId: cue.id }));

  const cueProgress = recordingCueProgress(tracklist);

  return (
    <div
      aria-label={`Studio clip editor for ${title}`}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-5 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,48rem)] xl:grid-rows-[minmax(0,1fr)] xl:gap-0 xl:overflow-hidden"
      onKeyDown={handleKeyDown}
      role="application"
    >
      <span aria-live="polite" className="sr-only">
        {liveMessage}
      </span>

      {/* Left pane (the cue list) — the AUTHORED tracklist (add/type/mark/remove) plus the
          recording's committed clips. It scrolls independently at xl+. */}
      <div className="flex min-w-0 flex-col xl:min-h-0 xl:overflow-y-auto xl:pr-6">
        <RecordingCueRail
          onAdd={addCueTrack}
          onClear={clearCueTrack}
          onEdit={editCueTrack}
          onMark={markCueTrack}
          onRemove={removeCueTrack}
          onSeek={(ms) => seek(ms / 1000)}
          onSelect={setSelectedCueId}
          saving={saveTracklist.isPending}
          selectedId={selectedCueId}
          tracklist={tracklist}
        />

        {/* Re-sync the live distribution from the cues — only once the recording is
            PROMOTED (its linked published mixtape exists). Un-promoted → return null. */}
        {recording.mixtapeId ? (
          <ResyncFromCues cuedCount={cueProgress.marked} mixtapeId={recording.mixtapeId} />
        ) : null}

        {/* The promoted-mixtape management block — the publish-time fields (the dream note,
            SoundCloud, distribution, the set-video toggle) resurface here once the take is a
            published mixtape (RFC §8, surface 5). Un-promoted → nothing. */}
        {recording.mixtapeId ? (
          <PromotedMixtapeBlock logId={recording.logId} mixtapeId={recording.mixtapeId} />
        ) : null}

        {/* The recording's clips so far. */}
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

      {/* Right pane (the visualiser) — the preview, transport, energy lane, clip
          toolbar. */}
      <div className="min-w-0 xl:min-h-0 xl:overflow-y-auto xl:border-l xl:border-border xl:pl-6">
        <div className="mx-auto w-full max-w-3xl">
          <Video.Surface
            className="studio-stage"
            mediaClassName="studio-stage-media"
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
            />
          </div>

          {/* The one quiet energy lane. A recording has no envelope, so this is just the
              rail + playhead + committed clips + the active band. */}
          <div className="mt-3">
            <StudioEnergyLane
              band={band ? { aFraction: band.inFraction, bFraction: band.outFraction } : null}
              clips={clips ?? []}
              cues={cueTicks}
              currentMs={currentMs}
              durationMs={durationMs}
              envelope={undefined}
              onBandPaint={(a, b) =>
                setBand({ inFraction: Math.min(a, b), outFraction: Math.max(a, b) })
              }
              onSeekFraction={seekFraction}
              suggestions={suggestionRegions}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              A recording has no energy analysis. Mark in/out by hand.
            </p>
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

// The platforms a mixtape can be re-synced to, in push order (YouTube first).
const RESYNC_PLATFORMS = ["youtube", "mixcloud"] as const;
type ResyncPlatform = (typeof RESYNC_PLATFORMS)[number];
type ResyncLeg = { message?: string; ok: boolean; platform: ResyncPlatform };

const PLATFORM_LABEL: Record<ResyncPlatform, string> = {
  mixcloud: "Mixcloud show",
  youtube: "YouTube video",
};

// ── Re-sync from cues ──────────────────────────────────────────────────────────
// Push the promoted recording's cues to its ALREADY-published distribution: re-derive
// the YouTube chapters + Mixcloud sections and edit the live video + show (no re-upload
// — the same server-side `resync_mixtape_*` ops the CLI calls). Only rendered once the
// recording is promoted (the parent guards on `recording.mixtapeId`); a platform without
// a distribution row is skipped. Disabled until ≥1 cue exists.
function ResyncFromCues({ cuedCount, mixtapeId }: { cuedCount: number; mixtapeId: string }) {
  const [results, setResults] = useState<ResyncLeg[] | null>(null);

  const { data: posts } = useQuery<MixtapeSocialPostItem[]>({
    queryFn: () => fetchMixtapeSocial(mixtapeId),
    queryKey: ["admin", "mixtape-social", mixtapeId],
    refetchOnWindowFocus: true,
  });

  const distributed = new Set((posts ?? []).map((post) => post.platform));
  const legs = RESYNC_PLATFORMS.filter((platform) => distributed.has(platform));
  const published = legs.length > 0;
  const canResync = published && cuedCount > 0;

  const resync = useMutation<ResyncLeg[]>({
    mutationFn: async () => {
      const out: ResyncLeg[] = [];

      for (const platform of legs) {
        const response = await fetch(
          `/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/${platform}/resync`,
          { method: "POST" },
        );

        out.push(
          response.ok
            ? { ok: true, platform }
            : { message: await readError(response), ok: false, platform },
        );
      }

      return out;
    },
    onMutate: () => setResults(null),
    onSuccess: (out) => setResults(out),
  });

  // Not published yet → nothing to re-sync; the control stays out of the way entirely.
  if (!published) {
    return null;
  }

  const platformList = legs.map((platform) => PLATFORM_LABEL[platform]).join(" + ");

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <ArrowsClockwiseIcon aria-hidden="true" weight="bold" />
          Live distribution
        </Label>
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button disabled={!canResync || resync.isPending} size="sm" variant="outline">
                {resync.isPending ? (
                  <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                ) : (
                  <ArrowsClockwiseIcon aria-hidden="true" weight="bold" />
                )}
                Re-sync from cues
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Push fresh chapters to the live {platformList}?</AlertDialogTitle>
              <AlertDialogDescription>
                This re-derives the tracklist from the {cuedCount} marked cue
                {cuedCount === 1 ? "" : "s"} and edits the already-published {platformList}. The
                title, audio, and video don't change — only the chapters and sections.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => resync.mutate()}>Re-sync</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {!canResync ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Mark at least one cue above, then push it to the live {platformList}.
        </p>
      ) : null}

      {results ? (
        <ul aria-live="polite" className="mt-2 space-y-1">
          {results.map((leg) => (
            <li className="flex items-center gap-1.5 text-xs" key={leg.platform}>
              {leg.ok ? (
                <CheckCircleIcon aria-hidden="true" className="text-foreground" weight="fill" />
              ) : (
                <WarningIcon aria-hidden="true" className="text-destructive" weight="fill" />
              )}
              <span className={leg.ok ? "text-muted-foreground" : "text-destructive"}>
                {PLATFORM_LABEL[leg.platform]}
                {leg.ok ? " synced" : `: ${leg.message ?? "failed"}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── Publish as mixtape ─────────────────────────────────────────────────────────
// The publish action on an UN-PROMOTED take: mint a scarce Log ID coordinate and turn the
// take into a published mixtape (a checkpoint of Fluncle dreaming). `promote_recording` is
// idempotent (mint-or-reuse); on success we invalidate the route so the header + the
// management block reflect the freshly-minted `logId`/`mixtapeId`.
//
// One Sun: the Studio's everyday gold is "Create clip" (the surface's whole job is clipping;
// publishing is a rarer, terminal action). So this HEADER trigger stays a quiet OUTLINE —
// the gold reappears only at the moment of commitment, on the confirm dialog's action — so
// no two golds ever compete in one viewport (RFC §8, DESIGN "The One Sun Rule").
function PublishAction({ recordingId }: { recordingId: string }) {
  const router = useRouter();
  const [error, setError] = useAutoNotice();

  const promote = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/admin/recordings/${encodeURIComponent(recordingId)}/promote`,
        { method: "POST" },
      );

      if (!response.ok) {
        throw new Error(await readError(response));
      }
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: async () => {
      await router.invalidate();
    },
  });

  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button disabled={promote.isPending} size="sm" variant="outline">
              {promote.isPending ? (
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
              ) : (
                <UploadSimpleIcon aria-hidden="true" weight="bold" />
              )}
              Publish as mixtape
            </Button>
          }
        />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish this take as a mixtape?</AlertDialogTitle>
            <AlertDialogDescription>
              This mints a scarce Log ID coordinate and turns the take into a published mixtape: a
              checkpoint of Fluncle dreaming. The coordinate is permanent. You can still edit the
              note, links, and distribution after.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={promote.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={promote.isPending} onClick={() => promote.mutate()}>
              Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error ? (
        <span className="sr-only" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

// ── The promoted-mixtape management block ──────────────────────────────────────
// Once a take is promoted, the publish-time fields the plan editor dropped (B1) resurface
// here (RFC §8, surface 5): the dream note, the SoundCloud link, the per-platform
// distribution strip, and the set-video toggle. Reuses the same server-side ops the old
// mixtape editor called (`update_mixtape` PATCH + the `/social` read). Fetches the mixtape
// DTO in-process; a null (a race, a missing row) hides the block.
function PromotedMixtapeBlock({ logId, mixtapeId }: { logId?: string; mixtapeId: string }) {
  const queryClient = useQueryClient();

  const { data: mixtape } = useQuery<MixtapeDTO | null>({
    queryFn: () => fetchStudioMixtape({ data: { mixtapeId } }),
    queryKey: ["admin", "studio-mixtape", mixtapeId],
    refetchOnWindowFocus: true,
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["admin", "studio-mixtape", mixtapeId] }),
    [queryClient, mixtapeId],
  );

  if (!mixtape) {
    return null;
  }

  return (
    <div className="mt-6 space-y-4 rounded-lg border border-border p-3">
      <div className="flex items-center gap-1.5">
        <CassetteTapeIcon aria-hidden="true" weight="fill" />
        <Label>Published mixtape</Label>
        {logId ? (
          <span className="studio-numeral text-xs text-muted-foreground tabular-nums">
            fluncle://{logId}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        It's a checkpoint now. The note, links, and distribution live here.
      </p>

      <NoteAndLinks mixtape={mixtape} refresh={refresh} />

      <DistributionStrip mixtapeId={mixtapeId} status={mixtape.status ?? "distributing"} />

      <AnnounceControl mixtape={mixtape} refresh={refresh} />

      {logId ? <SetVideoToggle mixtape={mixtape} refresh={refresh} /> : null}

      {logId ? (
        <a
          className="inline-flex text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-ring"
          href={`/log/${encodeURIComponent(logId)}`}
          rel="noreferrer"
          target="_blank"
        >
          View the public log page ↗
        </a>
      ) : null}
    </div>
  );
}

// The dream note + the one manual link (SoundCloud). Both PATCH `update_mixtape` on save
// (YouTube + Mixcloud are recorded by `distribute`, not editable here). Save-on-blur for
// the note; the SoundCloud field validates as an optional http(s) URL.
function NoteAndLinks({ mixtape, refresh }: { mixtape: MixtapeDTO; refresh: () => Promise<void> }) {
  const noteId = useId();
  const scId = useId();
  const [note, setNote] = useState(mixtape.note ?? "");
  const [soundcloudUrl, setSoundcloudUrl] = useState(mixtape.externalUrls.soundcloud ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useAutoNotice();
  const id = mixtape.id;
  const urlInvalid = !isOptionalHttpUrl(soundcloudUrl);

  const save = async (body: { note?: string; soundcloudUrl?: string }) => {
    if (!id) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      await saveMixtape(id, body);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={noteId}>Note</Label>
        <Textarea
          defaultValue={note}
          disabled={busy}
          id={noteId}
          onBlur={(event) => {
            const next = event.target.value;

            if (next !== (mixtape.note ?? "")) {
              setNote(next);
              void save({ note: next });
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          The dream note. It becomes the platform descriptions and the /log prose.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={scId}>SoundCloud URL</Label>
        <Input
          aria-invalid={urlInvalid}
          defaultValue={soundcloudUrl}
          disabled={busy}
          id={scId}
          onBlur={(event) => {
            const next = event.target.value.trim();

            if (next !== (mixtape.externalUrls.soundcloud ?? "") && isOptionalHttpUrl(next)) {
              setSoundcloudUrl(next);
              void save({ soundcloudUrl: next });
            }
          }}
          placeholder="https://soundcloud.com/fluncle/…"
        />
        <p className="text-xs text-muted-foreground">
          {urlInvalid ? "Must be a full http(s) URL." : "Paste after a manual SoundCloud upload."}
        </p>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// The per-platform distribution status: one row per platform (uploading / published /
// failed), a link once published, and the unlisted→public flip for YouTube while the
// mixtape is still `distributing`. Read from `/social` with focus-refetch ON.
const PLATFORM_LABELS: Record<string, string> = {
  mixcloud: "Mixcloud",
  soundcloud: "SoundCloud",
  youtube: "YouTube",
};

function DistributionStrip({ mixtapeId, status }: { mixtapeId: string; status: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "mixtape-social", mixtapeId] as const;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useAutoNotice();
  const [notice, setNotice] = useAutoNotice();

  const { data: posts } = useQuery({
    queryFn: () => fetchMixtapeSocial(mixtapeId),
    queryKey,
    refetchOnWindowFocus: true,
  });

  const youtube = posts?.find((post) => post.platform === "youtube");
  const canMakePublic = status === "distributing" && youtube !== undefined;

  const makePublic = async () => {
    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch(
        `/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/youtube/publish`,
        { method: "POST" },
      );

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      setNotice("YouTube video is public.");
      await queryClient.invalidateQueries({ queryKey });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label>Distribution</Label>
      {posts && posts.length > 0 ? (
        <div className="divide-y divide-border">
          {posts.map((post) => (
            <div className="flex items-center gap-3 py-2" key={post.platform}>
              <span className="w-20 shrink-0 text-sm">
                {PLATFORM_LABELS[post.platform] ?? post.platform}
              </span>
              <DistributionStatusBadge status={post.status} />
              {post.url ? (
                <a
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-ring"
                  href={post.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {post.url}
                </a>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No platforms yet. Run <code className="font-mono">fluncle admin mixtapes distribute</code>{" "}
          from the CLI.
        </p>
      )}

      {canMakePublic ? (
        <Button disabled={busy} onClick={() => void makePublic()} size="sm" variant="outline">
          {busy ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          ) : undefined}
          {busy ? "Publishing…" : "Make YouTube public"}
        </Button>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function DistributionStatusBadge({ status }: { status: string }) {
  const variant =
    status === "published" ? "default" : status === "failed" ? "destructive" : "outline";

  return (
    <Badge className="shrink-0 capitalize" variant={variant}>
      {status}
    </Badge>
  );
}

// ── Announce to the crew ───────────────────────────────────────────────────────
// The last lifecycle step: post the mixtape's crew callout to the Fluncle's Findings
// Telegram channel — Fluncle sharing his own dream/checkpoint (its listen links + the
// /log home, in the mixtape's own voice). Only once the mixtape is `published` (its
// first platform link landed, so there's something to listen to). Posting to a public
// channel is an external effect, so it sits behind a confirm (the resync/publish
// precedent). Idempotent server-side by an `announced_at` marker — once it's out the
// control flips to a quiet done state, so the crew is never double-posted. On success
// it echoes the exact text that went out.
function AnnounceControl({
  mixtape,
  refresh,
}: {
  mixtape: MixtapeDTO;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useAutoNotice();
  const [posted, setPosted] = useState<string | null>(null);
  const id = mixtape.id;
  const announced = Boolean(mixtape.announcedAt);

  // Nothing to announce until a listen link exists (published = the first platform
  // link landed). While still `distributing`, the control stays out of the way.
  if (mixtape.status !== "published") {
    return null;
  }

  const announce = async () => {
    if (!id) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}/announce`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const body = (await response.json()) as { message?: string };
      setPosted(body.message ?? null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5">
        <MegaphoneIcon aria-hidden="true" weight="fill" />
        Crew announcement
      </Label>

      {announced ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircleIcon aria-hidden="true" className="text-foreground" weight="fill" />
          Announced to the crew.
        </p>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button disabled={busy} size="sm" variant="outline">
                {busy ? (
                  <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                ) : (
                  <MegaphoneIcon aria-hidden="true" weight="bold" />
                )}
                Announce to the crew
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Post this mixtape to the crew?</AlertDialogTitle>
              <AlertDialogDescription>
                This posts the mixtape's callout to the Fluncle's Findings Telegram channel, in
                Fluncle's own dream/checkpoint voice, with its listen links and the log page. It
                goes out once; you can't un-send it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={() => void announce()}>
                Announce
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {posted ? (
        <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-xs text-foreground">
          {posted}
        </pre>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// The set-video gate: flip on AFTER uploading the full set video to R2 (`<log-id>/set.mp4`)
// and the mixtape's /log page shows the branded scrubber player. A flag, not an upload —
// writes `setVideoAt` through `update_mixtape`. Only shown once the coordinate is minted.
function SetVideoToggle({
  mixtape,
  refresh,
}: {
  mixtape: MixtapeDTO;
  refresh: () => Promise<void>;
}) {
  const switchId = useId();
  const on = Boolean(mixtape.setVideoAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useAutoNotice();
  const id = mixtape.id;

  const toggle = async (next: boolean) => {
    if (!id) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      await saveMixtape(id, { setVideoAt: next ? new Date().toISOString() : "" });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={switchId}>Set video</Label>
      <div className="flex items-center gap-3">
        <Switch
          checked={on}
          disabled={busy}
          id={switchId}
          onCheckedChange={(next) => void toggle(next)}
        />
        <span className="text-sm text-muted-foreground">
          {on ? "The set player is live on the log page." : "Off. No set player yet."}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Flip on after uploading the set video to{" "}
        <code className="font-mono">{mixtape.logId}/set.mp4</code> on R2.
      </p>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
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

async function fetchClips(recordingId: string): Promise<ClipDTO[]> {
  const response = await fetch(`/api/admin/clips?recordingId=${encodeURIComponent(recordingId)}`);

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const body = (await response.json()) as { clips?: ClipDTO[] };

  return body.clips ?? [];
}

async function fetchMixtapeSocial(mixtapeId: string): Promise<MixtapeSocialPostItem[]> {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/social`);

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const body = (await response.json()) as { posts?: MixtapeSocialPostItem[] };

  return body.posts ?? [];
}

// PATCH the promoted mixtape (`update_mixtape`): the dream note, the SoundCloud link, or the
// set-video flag. Each is its own field on the operator-tier op — a published mixtape stays
// editable there without touching its immutable minted coordinate.
async function saveMixtape(
  id: string,
  body: { note?: string; setVideoAt?: string; soundcloudUrl?: string },
) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

// An optional http(s) URL: empty is fine (clears the link), otherwise it must parse as
// http/https (the SoundCloud field).
function isOptionalHttpUrl(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return true;
  }

  try {
    const url = new URL(trimmed);

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
