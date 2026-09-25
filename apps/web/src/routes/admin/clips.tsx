import { FilmStripIcon } from "@phosphor-icons/react";
import { type ClipDTO, type RecordingDTO } from "@fluncle/contracts/orpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { readError } from "@/lib/read-error";
import { ensureAdmin } from "@/lib/admin-guard";
import { AdminShell } from "@/components/admin/admin-shell";
import { type ClipDrip, ClipCard } from "@/components/admin/clip-card";
import { Button } from "@fluncle/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@fluncle/ui/components/empty";
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
import { type ClipSocialPost, isDripPaused, listClipPosts } from "@/lib/server/clip-social";
import { listClips } from "@/lib/server/clips";
import { listRecordings } from "@/lib/server/recordings";
import { useAutoNotice } from "@/lib/use-auto-notice";
import {
  ALL_FILTER,
  type ClipStatusFilter,
  DEFAULT_CLIP_FILTER,
  filterClips,
  sortClipsNewestFirst,
} from "@/lib/studio-clips";

const fetchAllClips = createServerFn({ method: "GET" }).handler(async (): Promise<ClipDTO[]> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return listClips();
});

const fetchRecordings = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecordingDTO[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listRecordings();
  },
);

const fetchDripState = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ paused: boolean; posts: ClipSocialPost[] }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return { paused: await isDripPaused(), posts: await listClipPosts() };
  },
);

export const Route = createFileRoute("/admin/clips")({
  beforeLoad: () => ensureAdmin(),
  component: ClipLibraryPage,
  loader: async () => ({
    clips: await fetchAllClips(),
    drip: await fetchDripState(),
    recordings: await fetchRecordings(),
  }),
});

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

  const { data: recordings } = useQuery<RecordingDTO[]>({
    initialData: initialRecordings,
    queryFn: () => fetchRecordings(),
    queryKey: ["admin", "recordings"],
    refetchOnWindowFocus: true,
  });

  const { data: drip } = useQuery({
    initialData: initialDrip,
    queryFn: () => fetchDripState(),
    queryKey: ["admin", "clip-posts"],
    refetchOnWindowFocus: true,
  });

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

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const recordingById = useMemo(
    () => new Map(recordings.map((rec) => [rec.id, rec] as const)),
    [recordings],
  );

  const libraryClips = useMemo<LibraryClip[]>(
    () => clips.map((clip) => ({ ...clip, resolvedRecordingId: clip.recordingId })),
    [clips],
  );

  const recordingsWithClips = useMemo(() => {
    const ids = new Set(libraryClips.map((clip) => clip.resolvedRecordingId).filter(Boolean));

    return recordings.filter((rec) => ids.has(rec.id));
  }, [libraryClips, recordings]);

  useEffect(() => {
    if (recordingId !== ALL_FILTER && !recordingsWithClips.some((rec) => rec.id === recordingId)) {
      setRecordingId(ALL_FILTER);
    }
  }, [recordingId, recordingsWithClips]);

  const visible = useMemo<LibraryClip[]>(
    () => sortClipsNewestFirst(filterClips(libraryClips, { recordingId, status }) as LibraryClip[]),
    [libraryClips, recordingId, status],
  );

  const deleteClip = useMutation({
    mutationFn: async (clipId: string) => {
      const response = await fetch(`/api/v1/admin/clips/${encodeURIComponent(clipId)}`, {
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

  const setPaused = useMutation<void, Error, boolean, { previous?: typeof drip }>({
    mutationFn: async (paused: boolean) => {
      const response = await fetch("/api/v1/admin/clips/drip/state", {
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

  const batchSchedule = useMutation<{ scheduled: number }, Error, string[]>({
    mutationFn: async (clipIds: string[]) => {
      const response = await fetch("/api/v1/admin/clips/schedule", {
        body: JSON.stringify({ clipIds }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      return (await response.json()) as { scheduled: number };
    },
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

  const statusItems = { all: "Any state", done: "Ready", pending: "Cutting" } as const;

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

  const visibleIds = useMemo(() => new Set(visible.map((clip) => clip.id)), [visible]);

  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));

      return next.size === current.size ? current : next;
    });
  }, [visibleIds]);

  return (
    <AdminShell
      subtitle={`${clips.length} ${clips.length === 1 ? "clip" : "clips"} across every recording`}
      title="Clip library"
    >
      <div className="p-4 sm:p-5">
        <DripKillSwitch
          onToggle={(paused) => setPaused.mutate(paused)}
          paused={drip.paused}
          pending={setPaused.isPending}
        />

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
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="default">
          <FilmStripIcon aria-hidden="true" className="size-7 text-muted-foreground/70" />
        </EmptyMedia>
        <EmptyTitle>No clips yet</EmptyTitle>
        <EmptyDescription>
          Open a recording in the Studio and cut a few framed 9:16 clips. They land here, ready to
          hand-post.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
