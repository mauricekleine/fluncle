import { FilmStripIcon, ScissorsIcon } from "@phosphor-icons/react";
import { type ClipDTO, type RecordingDTO } from "@fluncle/contracts/orpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { ClipCard } from "@/components/admin/clip-card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isAdminRequest } from "@/lib/server/admin-auth";
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
// inline, download to hand-post (the irreducible in-app beat). Reads `list_clips` +
// `list_recordings`; `delete_clip` prunes a bad cut. Distribution is deferred (a disabled
// seam on the card).
//
// The grid, recordings, and dropdown load SERVER-SIDE (a createServerFn calling the
// server helpers in-process) — not a cross-origin client fetch. Filtering + newest-first
// sorting then run client-side over the loaded set (the backlog is small; instant, no
// refetch).

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

export const Route = createFileRoute("/admin/clips")({
  beforeLoad: () => ensureAdmin(),
  component: ClipLibraryPage,
  loader: async () => ({
    clips: await fetchAllClips(),
    recordings: await fetchRecordings(),
  }),
});

// A clip normalised onto its source recording id — a recording clip carries `recordingId`
// directly; a LEGACY mixtape clip is mapped onto its promoted recording (via the
// recording's `mixtapeId`), so both group + filter under one axis. An orphan legacy clip
// (a mixtape published before recordings, never backfilled) keeps `recordingId` undefined.
type LibraryClip = ClipDTO & { resolvedRecordingId: string | undefined };

function ClipLibraryPage() {
  const { clips: initialClips, recordings } = Route.useLoaderData();
  const queryClient = useQueryClient();

  const { data: clips } = useQuery<ClipDTO[]>({
    initialData: initialClips,
    queryFn: () => fetchAllClips(),
    queryKey: ["admin", "clips"],
    refetchOnWindowFocus: true,
  });

  const [recordingId, setRecordingId] = useState<string>(DEFAULT_CLIP_FILTER.recordingId);
  const [status, setStatus] = useState<ClipStatusFilter>(DEFAULT_CLIP_FILTER.status);
  const [error, setError] = useAutoNotice();
  const [notice, setNotice] = useAutoNotice();

  const recordingByMixtapeId = useMemo(
    () =>
      new Map(
        recordings
          .filter((rec) => rec.mixtapeId)
          .map((rec) => [rec.mixtapeId as string, rec] as const),
      ),
    [recordings],
  );

  // Every recording by its id — the per-card recording label lookup (each flat-grid card
  // still shows which set/mixtape its clip is from).
  const recordingById = useMemo(
    () => new Map(recordings.map((rec) => [rec.id, rec] as const)),
    [recordings],
  );

  // Normalise every clip onto its source recording id (a legacy mixtape clip → its
  // promoted recording), so grouping + filtering share the one axis.
  const libraryClips = useMemo<LibraryClip[]>(
    () =>
      clips.map((clip) => {
        const resolved =
          clip.recordingId ??
          (clip.mixtapeId ? recordingByMixtapeId.get(clip.mixtapeId)?.id : undefined);

        return { ...clip, recordingId: resolved, resolvedRecordingId: resolved };
      }),
    [clips, recordingByMixtapeId],
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

  return (
    <AdminShell
      current="clips"
      subtitle={`${clips.length} ${clips.length === 1 ? "clip" : "clips"} across every recording`}
      title="Clip library"
    >
      <div className="p-4 sm:p-5">
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
                  onDelete={() => deleteClip.mutate(clip.id)}
                  recording={
                    clip.resolvedRecordingId
                      ? recordingById.get(clip.resolvedRecordingId)
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminShell>
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
        No recordings yet. Create one from the CLI (
        <code className="font-mono text-xs">fluncle admin recordings create --video set.mov</code>
        ), then open it here to clip it.
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
