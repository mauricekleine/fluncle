import { FilmStripIcon, ScissorsIcon } from "@phosphor-icons/react";
import { type ClipDTO, type RecordingDTO } from "@fluncle/contracts/orpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { type ClipDrip, ClipCard } from "@/components/admin/clip-card";
import { UploadRecordingDialog } from "@/components/admin/upload-recording-dialog";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import { Label } from "@fluncle/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@fluncle/ui/components/select";
import { Switch } from "@fluncle/ui/components/switch";
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  type ClipSocialPost,
  isDripPaused,
  listClipPosts,
  nextDripSlot,
  upsertClipPost,
} from "@/lib/server/clip-social";
import { buildClipCaption } from "@/lib/server/clip-caption";
import { listClips } from "@/lib/server/clips";
import { listRecordings } from "@/lib/server/recordings";
import {
  ALL_FILTER,
  type ClipStatusFilter,
  DEFAULT_CLIP_FILTER,
  filterClips,
  sortClipsNewestFirst,
} from "@/lib/studio-clips";

// The cross-recording clip library + the recordings index (RFC recording-primitive,
// Design B — Wave 3). A captured set (a RECORDING) yields MANY clips; beyond the per-set
// editor (/admin/studio/$recordingId) this is ONE continuous grid of EVERY clip, sorted
// newest-first (by clip `createdAt`) — no per-recording grouping, but each card still
// carries its own recording label so the operator can tell which set/mixtape a clip is
// from. Above the grid sits a recordings index so the operator can find + open a
// CLI-created recording to clip it. Browse, filter (by recording + status), preview
// inline, download to hand-post. Reads `list_clips` + `list_recordings`; `delete_clip`
// prunes a bad cut.
//
// Distribution rides the Instagram DRIP-FEED (clip-drip-feed RFC §3.6): the page header
// carries the global KILL SWITCH (a Switch → `set_clip_drip`) and a BATCH schedule action
// over a selection (chaining the jittered ~daily slots server-side, `nextDripSlot`); each
// card shows its own drip state + a slot-override popover. The per-clip drip schedule (the
// `list_clip_posts` read) is merged onto the cards.
//
// The grid, recordings, dropdown, drip rows, and paused state load SERVER-SIDE (a
// createServerFn calling the server helpers in-process) — not a cross-origin client fetch.
// Filtering + newest-first sorting then run client-side over the loaded set (the backlog is
// small; instant, no refetch).

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// Every clip, newest-first. Server-side: in-process, no HTTP, no CORS.
const fetchAllClips = createServerFn({ method: "GET" }).handler(async (): Promise<ClipDTO[]> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return listClips();
});

// Every recording (the group headers + the recordings index + the filter dropdown).
const fetchRecordings = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecordingDTO[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listRecordings();
  },
);

// Every clip's Instagram drip row + whether the drip is paused (the kill switch's live
// state) — read together so the header switch and every card's chip hydrate from the loader.
const fetchDripState = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ paused: boolean; posts: ClipSocialPost[] }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return { paused: await isDripPaused(), posts: await listClipPosts() };
  },
);

// Batch-schedule a selection onto the drip queue. Chains the jittered ~daily slots
// SERVER-SIDE (one `nextDripSlot` roll per clip, each reading the extending queue tail so
// consecutive slots drift in [23h, 25h]), snapshotting a fresh caption per clip. Gated by
// the web admin grant — the "Login with Spotify" operator identity (the one web carrier),
// the same tier the `set_clip_schedule` op it stands in for requires.
const batchScheduleClips = createServerFn({ method: "POST" })
  .validator((data: { clipIds: string[] }) => data)
  .handler(async ({ data }): Promise<{ scheduled: number }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    let scheduled = 0;

    for (const clipId of data.clipIds) {
      // Chain off the live queue tail: each upsert extends it, so the next slot rolls ~24h
      // past this one (real jitter, no bot-at-10:00 cadence). Sequential by design.
      const scheduledFor = await nextDripSlot();
      const built = await buildClipCaption(clipId);

      await upsertClipPost({ caption: built.builtCaption, clipId, scheduledFor });
      scheduled += 1;
    }

    return { scheduled };
  });

export const Route = createFileRoute("/admin/clips")({
  beforeLoad: () => ensureAdmin(),
  component: ClipLibraryPage,
  loader: async () => ({
    clips: await fetchAllClips(),
    drip: await fetchDripState(),
    recordings: await fetchRecordings(),
  }),
});

// A clip carries `recordingId` directly — the one grouping/filtering axis, since the
// plan→recording→mixtape Deploy-2 cutover dropped the legacy `mixtapeId` owner (every
// legacy mixtape clip was repointed onto its mixtape's recording first).
type LibraryClip = ClipDTO & { resolvedRecordingId: string | undefined };

function ClipLibraryPage() {
  const {
    clips: initialClips,
    drip: initialDrip,
    recordings: initialRecordings,
  } = Route.useLoaderData();
  const queryClient = useQueryClient();

  const { data: clips } = useQuery<ClipDTO[]>({
    initialData: initialClips,
    queryFn: () => fetchAllClips(),
    queryKey: ["admin", "clips"],
    refetchOnWindowFocus: true,
  });

  // The recordings shelf/index + the filter dropdown, seeded from the loader and refetched on
  // focus — so a browser-uploaded recording lands here without a reload (the header
  // "Upload recording" action invalidates this key on success).
  const { data: recordings } = useQuery<RecordingDTO[]>({
    initialData: initialRecordings,
    queryFn: () => fetchRecordings(),
    queryKey: ["admin", "recordings"],
    refetchOnWindowFocus: true,
  });

  // The per-clip drip rows + the paused state, hydrated from the loader and refetched on
  // focus (so a slot the drip cron fires while the operator is away re-reads as `posted`).
  const { data: drip } = useQuery({
    initialData: initialDrip,
    queryFn: () => fetchDripState(),
    queryKey: ["admin", "clip-posts"],
    refetchOnWindowFocus: true,
  });

  // The drip row per clip id — merged onto each card as its `scheduled`/`posted`/`failed`
  // state (only the `instagram` platform rows exist today; keyed by clip).
  const dripByClip = useMemo(() => {
    const map = new Map<string, ClipDrip>();

    for (const post of drip.posts) {
      map.set(post.clipId, {
        postedUrl: post.postedUrl,
        scheduledFor: post.scheduledFor,
        status: post.status,
      });
    }

    return map;
  }, [drip.posts]);

  const [recordingId, setRecordingId] = useState<string>(DEFAULT_CLIP_FILTER.recordingId);
  const [status, setStatus] = useState<ClipStatusFilter>(DEFAULT_CLIP_FILTER.status);
  const [error, setError] = useAutoNotice();
  const [notice, setNotice] = useAutoNotice();

  // The batch-schedule selection: a set of clip ids the operator ticked to schedule together.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  // Every recording by its id — the per-card recording label lookup (each flat-grid card
  // still shows which set/mixtape its clip is from).
  const recordingById = useMemo(
    () => new Map(recordings.map((rec) => [rec.id, rec] as const)),
    [recordings],
  );

  // Every clip's source recording id is the one grouping/filter axis.
  const libraryClips = useMemo<LibraryClip[]>(
    () => clips.map((clip) => ({ ...clip, resolvedRecordingId: clip.recordingId })),
    [clips],
  );

  // The dropdown only offers recordings that actually yielded a clip — no empty options.
  const recordingsWithClips = useMemo(() => {
    const ids = new Set(libraryClips.map((clip) => clip.resolvedRecordingId).filter(Boolean));

    return recordings.filter((rec) => ids.has(rec.id));
  }, [libraryClips, recordings]);

  // If the active recording filter no longer has clips, fall back to "all".
  useEffect(() => {
    if (recordingId !== ALL_FILTER && !recordingsWithClips.some((rec) => rec.id === recordingId)) {
      setRecordingId(ALL_FILTER);
    }
  }, [recordingId, recordingsWithClips]);

  // Filter, then flatten to ONE continuous grid sorted newest-first by clip `createdAt`
  // (no per-recording grouping — each card keeps its own recording label).
  const visible = useMemo<LibraryClip[]>(
    () => sortClipsNewestFirst(filterClips(libraryClips, { recordingId, status }) as LibraryClip[]),
    [libraryClips, recordingId, status],
  );

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
      await queryClient.invalidateQueries({ queryKey: ["admin", "clips"] });
    },
  });

  // The kill switch: pause / resume the whole drip. Optimistic — flip the cached paused
  // state at once (the Switch tracks it instantly), roll back on error, re-read on settle.
  const setPaused = useMutation<void, Error, boolean, { previous?: typeof drip }>({
    mutationFn: async (paused: boolean) => {
      const response = await fetch("/api/admin/clips/drip/state", {
        body: JSON.stringify({ paused }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }
    },
    onError: (caught, _paused, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["admin", "clip-posts"], context.previous);
      }

      setError(caught.message);
    },
    onMutate: async (paused) => {
      await queryClient.cancelQueries({ queryKey: ["admin", "clip-posts"] });
      const previous = queryClient.getQueryData<typeof drip>(["admin", "clip-posts"]);

      if (previous) {
        queryClient.setQueryData(["admin", "clip-posts"], { ...previous, paused });
      }

      return { previous };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin", "clip-posts"] }),
  });

  // Batch-schedule the current selection onto the jittered drip queue (server-side chain).
  const batchSchedule = useMutation<{ scheduled: number }, Error, string[]>({
    mutationFn: (clipIds: string[]) => batchScheduleClips({ data: { clipIds } }),
    onError: (caught) => setError(caught.message),
    onSuccess: async (result) => {
      setNotice(
        result.scheduled === 1
          ? "Scheduled 1 clip onto the drip."
          : `Scheduled ${result.scheduled} clips onto the drip.`,
      );
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ["admin", "clip-posts"] });
    },
  });

  // The clip count per recording (for the recordings index), over ALL clips (not the
  // filtered view) so the index is a stable map of the backlog.
  const clipCountByRecording = useMemo(() => {
    const counts = new Map<string, number>();

    for (const clip of libraryClips) {
      if (clip.resolvedRecordingId) {
        counts.set(clip.resolvedRecordingId, (counts.get(clip.resolvedRecordingId) ?? 0) + 1);
      }
    }

    return counts;
  }, [libraryClips]);

  const statusItems = { all: "Any state", done: "Ready", pending: "Cutting" } as const;

  // Toggle one clip in the batch-schedule selection.
  const toggleSelected = (clipId: string) =>
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(clipId)) {
        next.delete(clipId);
      } else {
        next.add(clipId);
      }

      return next;
    });

  // Prune selections that scroll out of the filtered view (a filter change shouldn't leave a
  // hidden clip selected). Only cut, visible clips are selectable.
  const visibleIds = useMemo(() => new Set(visible.map((clip) => clip.id)), [visible]);

  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));

      return next.size === current.size ? current : next;
    });
  }, [visibleIds]);

  return (
    <AdminShell
      current="clips"
      headerActions={
        <UploadRecordingDialog
          onUploaded={() =>
            void queryClient.invalidateQueries({ queryKey: ["admin", "recordings"] })
          }
        />
      }
      subtitle={`${clips.length} ${clips.length === 1 ? "clip" : "clips"} across every recording`}
      title="Clip library"
    >
      <div className="p-4 sm:p-5">
        {/* The kill switch: pause / resume the whole Instagram drip-feed. Prominent at the top
            of the page — one flip halts every future scheduled post (the schedule stays
            intact). */}
        <DripKillSwitch
          onToggle={(paused) => setPaused.mutate(paused)}
          paused={drip.paused}
          pending={setPaused.isPending}
        />

        {/* The recordings index — every captured set, promoted or not, linking to its
            Studio. This is how the operator finds + opens a CLI-created recording. */}
        <RecordingsIndex clipCountByRecording={clipCountByRecording} recordings={recordings} />

        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="clip-recording-filter">Recording</Label>
            <Select
              items={recordingSelectItems(recordingsWithClips)}
              onValueChange={(value) => setRecordingId(value as string)}
              value={recordingId}
            >
              <SelectTrigger
                aria-label="Filter by recording"
                className="w-52"
                id="clip-recording-filter"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>All recordings</SelectItem>
                {recordingsWithClips.map((rec) => (
                  <SelectItem key={rec.id} value={rec.id}>
                    {recordingLabel(rec)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="clip-status-filter">State</Label>
            <Select
              items={statusItems}
              onValueChange={(value) => setStatus(value as ClipStatusFilter)}
              value={status}
            >
              <SelectTrigger
                aria-label="Filter by state"
                className="w-36"
                id="clip-status-filter"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any state</SelectItem>
                <SelectItem value="done">Ready</SelectItem>
                <SelectItem value="pending">Cutting</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {error ? (
          <p className="mb-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p aria-live="polite" className="mb-3 text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}

        {/* The batch-schedule bar — appears once the operator ticks one or more cut clips.
            Schedules the whole selection onto the jittered drip chain in one move. */}
        {selected.size > 0 ? (
          <BatchScheduleBar
            count={selected.size}
            onClear={() => setSelected(new Set())}
            onSchedule={() => batchSchedule.mutate([...selected])}
            pending={batchSchedule.isPending}
          />
        ) : null}

        {clips.length === 0 ? (
          <EmptyLibrary />
        ) : visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No clips match this filter.
          </p>
        ) : (
          <ul className="grid list-none grid-cols-2 gap-4 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map((clip) => (
              <li key={clip.id}>
                <ClipCard
                  clip={clip}
                  deleting={deleteClip.isPending && deleteClip.variables === clip.id}
                  drip={dripByClip.get(clip.id)}
                  onDelete={() => deleteClip.mutate(clip.id)}
                  onToggleSelected={() => toggleSelected(clip.id)}
                  recording={
                    clip.resolvedRecordingId
                      ? recordingById.get(clip.resolvedRecordingId)
                      : undefined
                  }
                  selected={selected.has(clip.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminShell>
  );
}

// The kill switch: a prominent Switch that pauses / resumes the entire Instagram drip-feed.
// Paused keeps every scheduled row intact — nothing fires until the operator flips it live.
function DripKillSwitch({
  onToggle,
  paused,
  pending,
}: {
  onToggle: (paused: boolean) => void;
  paused: boolean;
  pending: boolean;
}) {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <Switch
          aria-label="Pause the Instagram drip-feed"
          checked={!paused}
          disabled={pending}
          id="drip-kill-switch"
          onCheckedChange={(next) => onToggle(!next)}
        />
      </div>
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor="drip-kill-switch">Instagram drip-feed</Label>
        <p className="text-sm text-muted-foreground">
          {paused
            ? "Paused. Nothing fires until you flip it back."
            : "Live. Posting to Instagram, roughly one a day."}
        </p>
      </div>
    </div>
  );
}

// The batch-schedule action bar: shown while a selection exists. Schedules the whole
// selection onto the jittered drip chain server-side, or clears the selection.
function BatchScheduleBar({
  count,
  onClear,
  onSchedule,
  pending,
}: {
  count: number;
  onClear: () => void;
  onSchedule: () => void;
  pending: boolean;
}) {
  return (
    <div
      aria-live="polite"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3"
    >
      <span className="text-sm text-muted-foreground">
        {count} {count === 1 ? "clip" : "clips"} selected
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <Button disabled={pending} onClick={onSchedule} size="sm">
          {count === 1 ? "Schedule 1 clip" : `Schedule ${count} clips`}
        </Button>
        <Button disabled={pending} onClick={onClear} size="sm" variant="ghost">
          Clear
        </Button>
      </div>
    </div>
  );
}

// The recordings index: every captured set with its title, clip count, and a promoted
// badge, each linking to its Studio. A recording with no clips still appears — that's the
// point (open it to cut the first clip).
function RecordingsIndex({
  clipCountByRecording,
  recordings,
}: {
  clipCountByRecording: Map<string, number>;
  recordings: RecordingDTO[];
}) {
  if (recordings.length === 0) {
    return (
      <div className="mb-6 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        No recordings yet. Hit <span className="font-medium text-foreground">Upload recording</span>{" "}
        up top to stage a captured set, then open it here to clip it.
      </div>
    );
  }

  return (
    <div className="mb-6">
      <Label className="flex items-center gap-1.5">
        <ScissorsIcon aria-hidden="true" />
        Recordings ({recordings.length})
      </Label>
      <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
        {recordings.map((rec) => (
          <li className="flex items-center gap-3 px-3 py-2" key={rec.id}>
            <a
              className="min-w-0 flex-1 truncate text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
              href={`/admin/studio/${encodeURIComponent(rec.id)}`}
            >
              {rec.title}
            </a>
            {rec.logId ? (
              <Badge variant="default">promoted · fluncle://{rec.logId}</Badge>
            ) : (
              <Badge variant="outline">recording</Badge>
            )}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {clipCountByRecording.get(rec.id) ?? 0} clip
              {(clipCountByRecording.get(rec.id) ?? 0) === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A recording's display label for the filter dropdown: its coordinate once promoted
// (`fluncle://<logId>`), else its title.
function recordingLabel(recording: RecordingDTO): string {
  return recording.logId ? `fluncle://${recording.logId}` : recording.title;
}

function recordingSelectItems(recordings: RecordingDTO[]): Record<string, string> {
  return {
    [ALL_FILTER]: "All recordings",
    ...Object.fromEntries(recordings.map((rec) => [rec.id, recordingLabel(rec)] as const)),
  };
}

function EmptyLibrary() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <FilmStripIcon aria-hidden="true" className="size-7 text-muted-foreground/70" />
      <p className="font-medium">No clips yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Open a recording in the Studio and cut a few framed 9:16 clips. They land here, ready to
        hand-post.
      </p>
    </div>
  );
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

// A transient notice that clears itself after 5s (the editor's pattern).
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
