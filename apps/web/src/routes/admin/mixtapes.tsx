import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CaretDownIcon,
  CaretRightIcon,
  CircleNotchIcon,
  DotsSixVerticalIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type MixtapeSocialPostItem } from "@fluncle/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AdminShell } from "@/components/admin/admin-shell";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { formatAlbumDuration, formatDurationField, parseDuration } from "@/lib/format";
import { hasExternalUrl, type MixtapeDTO } from "@/lib/mixtapes";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { type MixtapeInput } from "@/lib/server/mixtapes";
import { listMixtapes } from "@/lib/server/mixtapes";
import { type TrackListItem } from "@/lib/server/tracks";

const MIXTAPES_KEY = ["admin", "mixtapes"] as const;

// The cover-render row is the minimal slice of a banger the builder keeps.
type MemberRef = {
  albumImageUrl?: string;
  artists: string[];
  durationMs: number;
  logId?: string;
  title: string;
  trackId: string;
};

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchMixtapes = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return listMixtapes({ hydrateMembers: true, includeDrafts: true });
});

export const Route = createFileRoute("/admin/mixtapes")({
  beforeLoad: () => ensureAdmin(),
  component: AdminMixtapesPage,
  loader: () => fetchMixtapes(),
});

function AdminMixtapesPage() {
  const initialMixtapes = Route.useLoaderData();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useAutoNotice();
  const [error, setError] = useAutoNotice();
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { data: mixtapes } = useQuery({
    initialData: initialMixtapes,
    queryFn: () => fetchMixtapes(),
    queryKey: MIXTAPES_KEY,
    refetchOnWindowFocus: true,
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: MIXTAPES_KEY }),
    [queryClient],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const createDraft = async () => {
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch("/api/admin/mixtapes", {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = (await response.json()) as { mixtape?: { id?: string } };
      const newId = body.mixtape?.id;
      await refresh();
      if (newId) {
        setExpanded((prev) => new Set(prev).add(newId));
      }
      setNotice("Draft logged.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <AdminShell
      current="mixtapes"
      subtitle={`${mixtapes.length} checkpoint${mixtapes.length === 1 ? "" : "s"}`}
      title="Mixtapes"
    >
      <div className="p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button disabled={creating} onClick={() => void createDraft()}>
            {creating ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : undefined}
            {creating ? "Logging…" : "New mixtape draft"}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </div>

        {mixtapes.length === 0 ? (
          <EmptyState
            body="Log a draft to start a checkpoint — Fluncle dreaming, made from bangers."
            title="No checkpoints yet"
          />
        ) : (
          <div className="plate-field overflow-hidden rounded-lg">
            {mixtapes.map((mixtape) => {
              const id = mixtape.id ?? mixtape.title;
              return (
                <MixtapeEditor
                  key={id}
                  expanded={expanded.has(id)}
                  mixtape={mixtape}
                  onToggle={() => toggleExpanded(id)}
                  refresh={refresh}
                />
              );
            })}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function MixtapeEditor({
  expanded,
  mixtape,
  onToggle,
  refresh,
}: {
  expanded: boolean;
  mixtape: MixtapeDTO;
  onToggle: () => void;
  refresh: () => Promise<void>;
}) {
  const noteId = useId();
  const headerId = useId();
  const bodyId = useId();
  const [note, setNote] = useState(mixtape.note ?? "");
  const [recordedAt, setRecordedAt] = useState(mixtape.recordedAt?.slice(0, 10) ?? "");
  const [plannedFor, setPlannedFor] = useState(toLocalDateTime(mixtape.plannedFor));
  const [durationField, setDurationField] = useState(formatDurationField(mixtape.durationMs));
  const [mixcloudUrl, setMixcloudUrl] = useState(mixtape.externalUrls.mixcloud ?? "");
  const [youtubeUrl, setYoutubeUrl] = useState(mixtape.externalUrls.youtube ?? "");
  const [soundcloudUrl, setSoundcloudUrl] = useState(mixtape.externalUrls.soundcloud ?? "");
  const [members, setMembers] = useState<MemberRef[]>(() => mixtape.members.map(toMemberRef));
  const [error, setError] = useAutoNotice();
  const [notice, setNotice] = useAutoNotice();
  const [busy, setBusy] = useState(false);

  // "minted" = the coordinate is committed: a `distributing` mixtape (assets
  // uploading) or a fully public `published` one. Both lock the draft-only edits
  // (members, recorded date) and show the Log ID + cover; only a real draft offers
  // Publish / Discard. The server enforces the same (assertDraftMixtape).
  const minted = mixtape.status !== "draft";

  const stateRef = useRef({
    durationField,
    members,
    mixcloudUrl,
    note,
    plannedFor,
    recordedAt,
    soundcloudUrl,
    youtubeUrl,
  });
  useEffect(() => {
    stateRef.current = {
      durationField,
      members,
      mixcloudUrl,
      note,
      plannedFor,
      recordedAt,
      soundcloudUrl,
      youtubeUrl,
    };
  });

  // Re-adopt server values after a refresh only when the local value still
  // equals the previously-seen server value, so unsaved edits aren't clobbered.
  const lastServer = useRef(mixtape);
  useEffect(() => {
    const local = stateRef.current;
    const prev = lastServer.current;
    if (local.note === (prev.note ?? "")) {
      setNote(mixtape.note ?? "");
    }
    if (local.recordedAt === (prev.recordedAt?.slice(0, 10) ?? "")) {
      setRecordedAt(mixtape.recordedAt?.slice(0, 10) ?? "");
    }
    if (local.plannedFor === toLocalDateTime(prev.plannedFor)) {
      setPlannedFor(toLocalDateTime(mixtape.plannedFor));
    }
    if (local.durationField === formatDurationField(prev.durationMs)) {
      setDurationField(formatDurationField(mixtape.durationMs));
    }
    if (local.mixcloudUrl === (prev.externalUrls.mixcloud ?? "")) {
      setMixcloudUrl(mixtape.externalUrls.mixcloud ?? "");
    }
    if (local.youtubeUrl === (prev.externalUrls.youtube ?? "")) {
      setYoutubeUrl(mixtape.externalUrls.youtube ?? "");
    }
    if (local.soundcloudUrl === (prev.externalUrls.soundcloud ?? "")) {
      setSoundcloudUrl(mixtape.externalUrls.soundcloud ?? "");
    }
    if (membersRefsEqual(local.members, prev.members.map(toMemberRef))) {
      setMembers(mixtape.members.map(toMemberRef));
    }
    lastServer.current = mixtape;
  }, [mixtape]);

  const parsedDurationMs = parseDuration(durationField);
  const durationInvalid = durationField.trim().length > 0 && parsedDurationMs === null;
  const urlInvalid =
    !isOptionalHttpUrl(mixcloudUrl) ||
    !isOptionalHttpUrl(youtubeUrl) ||
    !isOptionalHttpUrl(soundcloudUrl);
  const saveDisabled = busy || durationInvalid || urlInvalid;

  const hasLink = hasExternalUrl({
    mixcloud: mixcloudUrl.trim() || undefined,
    soundcloud: soundcloudUrl.trim() || undefined,
    youtube: youtubeUrl.trim() || undefined,
  });

  // Publishing canonicalizes the title and derives the cover, but everything
  // else must be present first. Gate the button on the live editor state.
  const missingToPublish = [
    recordedAt.trim().length === 0 ? "a recorded date" : undefined,
    note.trim().length === 0 ? "a note" : undefined,
    parsedDurationMs === null ? "a duration" : undefined,
    !hasLink ? "a platform link" : undefined,
    members.length === 0 ? "a banger" : undefined,
  ].filter((label): label is string => label !== undefined);

  const save = () => {
    if (durationInvalid) {
      setError("Duration must be mm:ss or h:mm:ss, or a millisecond count.");
      return;
    }
    if (urlInvalid) {
      setError("Links must be full http(s) URLs.");
      return;
    }
    void run(async () => {
      const id = mixtape.id as string;
      await saveMixtape(id, {
        durationMs: parsedDurationMs,
        mixcloudUrl,
        note,
        plannedFor: fromLocalDateTime(plannedFor),
        recordedAt,
        soundcloudUrl,
        youtubeUrl,
      });
      // Members are draft-only and the endpoint rejects empty arrays, so push
      // only when this is a draft with a non-empty list that differs from the
      // server's current tracklist.
      const serverRefs = mixtape.members.map(toMemberRef);
      if (!minted && members.length > 0 && !membersRefsEqual(members, serverRefs)) {
        await replaceMembers(id, members);
      }
    }, "Mixtape saved.");
  };

  const publish = () => {
    void run(async () => {
      await publishMixtape(mixtape.id as string);
    }, "Mixtape published.");
  };

  const discard = () => {
    void run(async () => {
      await deleteMixtape(mixtape.id as string);
    }, "Draft discarded.");
  };

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setNotice(success);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-b border-border last:border-b-0">
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring sm:px-5"
        id={headerId}
        onClick={onToggle}
        type="button"
      >
        {expanded ? (
          <CaretDownIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
        ) : (
          <CaretRightIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-mono text-xs tracking-tight text-muted-foreground tabular-nums">
          {mixtape.logId ?? "draft"}
        </span>
        <Badge className="shrink-0" variant={minted ? "default" : "outline"}>
          {mixtape.status ?? "draft"}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-bold">
          {mixtape.logId ? mixtape.title : "Mixtape draft"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {mixtape.memberCount} banger{mixtape.memberCount === 1 ? "" : "s"}
          {mixtape.durationMs ? ` · ${formatAlbumDuration(mixtape.durationMs)}` : ""}
        </span>
      </button>

      {expanded ? (
        <div className="px-4 pb-4 sm:px-5" id={bodyId} role="region">
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              disabled={minted}
              label="Recorded"
              type="date"
              value={recordedAt}
              onChange={setRecordedAt}
            />
            <Field
              hint="Set a future live session to announce it on /calendar.ics. Clear to hide."
              label="Live session"
              type="datetime-local"
              value={plannedFor}
              onChange={setPlannedFor}
            />
            <Field
              hint={
                durationInvalid
                  ? "Must be mm:ss or h:mm:ss, or a millisecond count."
                  : parsedDurationMs !== null && durationField
                    ? formatAlbumDuration(parsedDurationMs)
                    : undefined
              }
              invalid={durationInvalid}
              label="Duration"
              placeholder="mm:ss or h:mm:ss"
              value={durationField}
              onChange={setDurationField}
            />
            <Field
              hint={isOptionalHttpUrl(mixcloudUrl) ? undefined : "Must be a full http(s) URL."}
              invalid={!isOptionalHttpUrl(mixcloudUrl)}
              label="Mixcloud URL"
              value={mixcloudUrl}
              onChange={setMixcloudUrl}
            />
            <Field
              hint={isOptionalHttpUrl(youtubeUrl) ? undefined : "Must be a full http(s) URL."}
              invalid={!isOptionalHttpUrl(youtubeUrl)}
              label="YouTube URL"
              value={youtubeUrl}
              onChange={setYoutubeUrl}
            />
            <Field
              hint={isOptionalHttpUrl(soundcloudUrl) ? undefined : "Must be a full http(s) URL."}
              invalid={!isOptionalHttpUrl(soundcloudUrl)}
              label="SoundCloud URL"
              value={soundcloudUrl}
              onChange={setSoundcloudUrl}
            />
          </div>

          <div className="mt-3 space-y-1.5">
            <Label htmlFor={noteId}>Note</Label>
            <Textarea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>

          <div className="mt-3">
            <MembersBuilder members={members} published={minted} onChange={setMembers} />
          </div>

          {minted && mixtape.logId ? (
            <div className="plate-field mt-4 rounded-lg p-3">
              <p className="text-xs font-bold text-muted-foreground">Cover</p>
              <div className="mt-2 flex gap-3">
                <img
                  alt=""
                  className="size-24 shrink-0 rounded-md border border-border object-cover"
                  src={`/api/mixtape-cover/${encodeURIComponent(mixtape.logId)}?size=square`}
                />
                <p className="text-xs text-muted-foreground">
                  Rendered on the fly — no upload needed.
                </p>
              </div>
            </div>
          ) : null}

          {minted && mixtape.id ? (
            <DistributionStrip mixtapeId={mixtape.id} status={mixtape.status} />
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button disabled={saveDisabled} onClick={save}>
              {busy ? (
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
              ) : undefined}
              {busy ? "Saving…" : "Save"}
            </Button>
            {minted ? null : (
              <Button
                disabled={busy || missingToPublish.length > 0}
                onClick={publish}
                variant="outline"
              >
                Publish mixtape
              </Button>
            )}
            {minted ? null : (
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button disabled={busy} variant="destructive">
                      <TrashIcon aria-hidden="true" />
                      Discard draft
                    </Button>
                  }
                />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The draft and its tracklist will be permanently removed. This can't be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Keep draft</AlertDialogCancel>
                    <AlertDialogAction disabled={busy} onClick={discard} variant="destructive">
                      {busy ? (
                        <CircleNotchIcon
                          aria-hidden="true"
                          className="animate-spin"
                          weight="bold"
                        />
                      ) : undefined}
                      {busy ? "Discarding…" : "Discard draft"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
          {!minted && missingToPublish.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Add {missingToPublish.join(", ")} to publish.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p aria-live="polite" className="mt-2 text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// The per-platform distribution status for a minted mixtape: one row per platform
// (uploading / published / failed), a link once published, and the recurring
// unlisted→public flip for YouTube while the mixtape is still `distributing`. Read
// from /api/admin/mixtapes/:id/social with focus-refetch ON (admin convention) so
// the operator watches a CLI distribute run land without a manual reload.
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: MIXTAPES_KEY }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plate-field mt-4 rounded-lg p-3">
      <p className="text-xs font-bold text-muted-foreground">Distribution</p>
      {posts && posts.length > 0 ? (
        <div className="mt-2 divide-y divide-border">
          {posts.map((post) => (
            <div key={post.platform} className="flex items-center gap-3 py-2">
              <span className="w-20 shrink-0 text-sm capitalize">{post.platform}</span>
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
        <p className="mt-2 text-xs text-muted-foreground">
          No platforms yet. Run <code className="font-mono">fluncle admin mixtapes distribute</code>{" "}
          from the CLI.
        </p>
      )}

      {canMakePublic ? (
        <div className="mt-3">
          <Button disabled={busy} onClick={() => void makePublic()} variant="outline">
            {busy ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : undefined}
            {busy ? "Publishing…" : "Make YouTube public"}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p aria-live="polite" className="mt-2 text-sm text-muted-foreground">
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

function MembersBuilder({
  members,
  onChange,
  published,
}: {
  members: MemberRef[];
  onChange: Dispatch<SetStateAction<MemberRef[]>>;
  published: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const add = useCallback(
    (track: MemberRef) => {
      onChange((prev) =>
        prev.some((member) => member.trackId === track.trackId) ? prev : [...prev, track],
      );
    },
    [onChange],
  );

  const remove = useCallback(
    (trackId: string) => {
      onChange((prev) => prev.filter((member) => member.trackId !== trackId));
    },
    [onChange],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      onChange((prev) => {
        const from = prev.findIndex((member) => member.trackId === active.id);
        const to = prev.findIndex((member) => member.trackId === over.id);
        if (from === -1 || to === -1) {
          return prev;
        }
        return arrayMove(prev, from, to);
      });
    },
    [onChange],
  );

  const countLabel = `${members.length} banger${members.length === 1 ? "" : "s"}`;

  if (published) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Tracklist</Label>
          <span className="text-xs text-muted-foreground tabular-nums">{countLabel}</span>
        </div>
        <div className="plate-field divide-y divide-border rounded-lg">
          {members.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">No bangers logged.</p>
          ) : (
            members.map((member) => (
              <div key={member.trackId} className="flex items-center gap-3 px-3 py-2">
                <MemberThumb src={member.albumImageUrl} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {member.artists.join(", ")} — {member.title}
                </span>
                {member.logId ? (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {member.logId}
                  </span>
                ) : null}
                {member.durationMs ? (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatAlbumDuration(member.durationMs)}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          The tracklist locks once a checkpoint is published.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>Tracklist</Label>
        <span className="text-xs text-muted-foreground tabular-nums">{countLabel}</span>
      </div>
      <MemberSearch onSelect={add} selected={members} />
      <div className="plate-field rounded-lg">
        {members.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            Search a banger to start the tracklist.
          </p>
        ) : (
          <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
            <SortableContext
              items={members.map((member) => member.trackId)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y divide-border">
                {members.map((member) => (
                  <SortableMemberRow
                    key={member.trackId}
                    member={member}
                    onRemove={remove}
                    reducedMotion={reducedMotion}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

function SortableMemberRow({
  member,
  onRemove,
  reducedMotion,
}: {
  member: MemberRef;
  onRemove: (trackId: string) => void;
  reducedMotion: boolean;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: member.trackId,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: reducedMotion ? undefined : transition,
  };

  return (
    <li
      className={`flex items-center gap-2 px-2 py-2 ${isDragging ? "relative z-10 bg-muted" : ""}`}
      ref={setNodeRef}
      style={style}
    >
      <button
        aria-label={`Reorder ${member.title}`}
        className="shrink-0 cursor-grab touch-none rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        type="button"
        {...attributes}
        {...listeners}
      >
        <DotsSixVerticalIcon aria-hidden="true" />
      </button>
      <MemberThumb src={member.albumImageUrl} />
      <span className="min-w-0 flex-1 truncate text-sm">
        {member.artists.join(", ")} — {member.title}
      </span>
      {member.logId ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {member.logId}
        </span>
      ) : null}
      {member.durationMs ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatAlbumDuration(member.durationMs)}
        </span>
      ) : null}
      <button
        aria-label={`Remove ${member.title}`}
        className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => onRemove(member.trackId)}
        type="button"
      >
        <XIcon aria-hidden="true" />
      </button>
    </li>
  );
}

function MemberSearch({
  onSelect,
  selected,
}: {
  onSelect: (track: MemberRef) => void;
  selected: MemberRef[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 250);
  const trimmed = debounced.trim();
  const selectedIds = useMemo(() => new Set(selected.map((member) => member.trackId)), [selected]);

  const { data, isFetching } = useQuery({
    enabled: trimmed.length > 0,
    placeholderData: (prev) => prev,
    queryFn: () => searchAdminTracks(trimmed),
    queryKey: ["admin", "track-search", trimmed],
    staleTime: 30_000,
  });

  const results = data ?? [];

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button className="w-full justify-start" variant="outline">
            Add a banger…
          </Button>
        }
      />
      <PopoverContent align="start" className="w-(--anchor-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput
            onValueChange={setQuery}
            placeholder="Search by Log ID, title, or artist"
            value={query}
          />
          <CommandList>
            {trimmed.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Type to find a banger.
              </p>
            ) : isFetching && results.length === 0 ? (
              <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                Searching…
              </p>
            ) : (
              <>
                <CommandEmpty>No bangers match.</CommandEmpty>
                {results.map((track) => (
                  <CommandItem
                    key={track.trackId}
                    disabled={selectedIds.has(track.trackId)}
                    onSelect={() => onSelect(toTrackRef(track))}
                    value={track.trackId}
                  >
                    <MemberThumb src={track.albumImageUrl} />
                    <span className="min-w-0 flex-1 truncate">
                      {track.artists.join(", ")} — {track.title}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      {track.logId ?? track.trackId}
                    </span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function MemberThumb({ src }: { src?: string }) {
  if (src) {
    return (
      <img
        alt=""
        className="size-8 shrink-0 rounded-sm border border-border object-cover"
        src={src}
      />
    );
  }
  return <div className="track-artwork-fallback size-8 shrink-0 rounded-sm border border-border" />;
}

function Field({
  disabled,
  hint,
  id: providedId,
  invalid,
  label,
  onChange,
  placeholder,
  type,
  value,
}: {
  disabled?: boolean;
  hint?: ReactNode;
  id?: string;
  invalid?: boolean;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  value: string;
}) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-invalid={invalid ? true : undefined}
        disabled={disabled}
        id={id}
        placeholder={placeholder}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p className={`text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function EmptyState({ body, title }: { body: string; title: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
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

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(media.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// An ISO instant → the `datetime-local` input's value (local wall-clock, no zone,
// minute precision). Empty string when unset.
function toLocalDateTime(iso?: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The `datetime-local` value (local wall-clock) → an ISO instant for the API.
// Empty string clears the field (server stores null).
function fromLocalDateTime(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function toMemberRef(member: MixtapeDTO["members"][number]): MemberRef {
  return {
    albumImageUrl: member.albumImageUrl,
    artists: member.artists,
    durationMs: member.durationMs,
    logId: member.logId,
    title: member.title,
    trackId: member.trackId,
  };
}

function toTrackRef(track: TrackListItem): MemberRef {
  return {
    albumImageUrl: track.albumImageUrl,
    artists: track.artists,
    durationMs: track.durationMs,
    logId: track.logId,
    title: track.title,
    trackId: track.trackId,
  };
}

function membersRefsEqual(a: MemberRef[], b: MemberRef[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((member, index) => {
    const other = b[index];
    return (member.logId ?? member.trackId) === (other.logId ?? other.trackId);
  });
}

function isOptionalHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || isHttpUrl(trimmed);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
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

async function searchAdminTracks(q: string): Promise<TrackListItem[]> {
  const response = await fetch(`/api/admin/tracks?q=${encodeURIComponent(q)}&limit=20`);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { tracks?: TrackListItem[] };
  return body.tracks ?? [];
}

async function fetchMixtapeSocial(id: string): Promise<MixtapeSocialPostItem[]> {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}/social`);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { posts?: MixtapeSocialPostItem[] };
  return body.posts ?? [];
}

async function saveMixtape(id: string, body: MixtapeInput) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function replaceMembers(id: string, members: MemberRef[]) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}/members`, {
    body: JSON.stringify({
      members: members.map((member) => member.logId ?? member.trackId),
    }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function publishMixtape(id: string) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}/publish`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function deleteMixtape(id: string) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
