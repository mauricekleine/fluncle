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
  CassetteTapeIcon,
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
  useSyncExternalStore,
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
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { type MixtapeDTO, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { type MixtapeInput, type MixtapeMembership } from "@/lib/server/mixtapes";
import { listMixtapes } from "@/lib/server/mixtapes";
import { type TrackListItem } from "@/lib/server/tracks";
import { cn } from "@/lib/utils";

const MIXTAPES_KEY = ["admin", "mixtapes"] as const;

// The cover-render row is the minimal slice of a banger the builder keeps.
type MemberRef = {
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  durationMs: number;
  key?: string;
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

  // Every finding already on a tape, keyed by trackId — built from the loaded
  // mixtapes (members are hydrated), so the track search can flag a banger that's
  // already spoken for. We want mixtapes largely unique; this is a soft cue, not a
  // block. (See the same MixtapeMembership the board reads.)
  const membershipByTrack = useMemo(() => {
    const map = new Map<string, MixtapeMembership[]>();
    for (const mixtape of mixtapes) {
      for (const member of mixtape.members) {
        const list = map.get(member.trackId) ?? [];
        list.push({
          logId: mixtape.logId,
          mixtapeId: mixtape.id ?? "",
          status: mixtape.status ?? "draft",
          title: mixtape.title,
        });
        map.set(member.trackId, list);
      }
    }
    return map;
  }, [mixtapes]);

  // Drafts ride on top — the operator is here to build the open one, not admire the
  // published ones. Stable sort keeps the published order (newest coordinate first)
  // intact below.
  const sortedMixtapes = useMemo(
    () => [...mixtapes].sort((a, b) => draftRank(a.status) - draftRank(b.status)),
    [mixtapes],
  );

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
      headerActions={
        <Button disabled={creating} onClick={() => void createDraft()} size="sm">
          {creating ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          ) : undefined}
          {creating ? (
            "Logging…"
          ) : (
            <>
              <span className="sm:hidden">New draft</span>
              <span className="hidden sm:inline">New mixtape draft</span>
            </>
          )}
        </Button>
      }
      title="Mixtapes"
    >
      <div className="p-4 sm:p-5">
        {error || notice ? (
          <div className="mb-4 flex flex-wrap items-center gap-3">
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
        ) : null}

        {mixtapes.length === 0 ? (
          <EmptyState
            body="Log a draft to start a checkpoint: Fluncle dreaming, made from bangers."
            title="No checkpoints yet"
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {sortedMixtapes.map((mixtape) => {
              const id = mixtape.id ?? mixtape.title;
              return (
                <MixtapeEditor
                  key={id}
                  expanded={expanded.has(id)}
                  membershipByTrack={membershipByTrack}
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

// Pure drafts sort above everything minted (distributing / published).
function draftRank(status?: string): number {
  return status === "draft" ? 0 : 1;
}

function MixtapeEditor({
  expanded,
  membershipByTrack,
  mixtape,
  onToggle,
  refresh,
}: {
  expanded: boolean;
  membershipByTrack: Map<string, MixtapeMembership[]>;
  mixtape: MixtapeDTO;
  onToggle: () => void;
  refresh: () => Promise<void>;
}) {
  const noteId = useId();
  const headerId = useId();
  const bodyId = useId();
  const [note, setNote] = useState(mixtape.note ?? "");
  const [recordedAt, setRecordedAt] = useState(mixtape.recordedAt?.slice(0, 10) ?? "");
  const [plannedFor, setPlannedFor] = useState(() => toLocalDateTime(mixtape.plannedFor));
  const [durationField, setDurationField] = useState(() => formatDurationField(mixtape.durationMs));
  // SoundCloud is the one manual link (YouTube + Mixcloud are recorded by `distribute`
  // and shown read-only in the Distribution strip).
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
    note,
    plannedFor,
    recordedAt,
    soundcloudUrl,
  });
  useEffect(() => {
    stateRef.current = {
      durationField,
      members,
      note,
      plannedFor,
      recordedAt,
      soundcloudUrl,
    };
  });

  // The draft persists itself. A signature of the savable fields (and, for a
  // draft, the tracklist) drives the dirty check; we compare against the value we
  // last persisted, not the possibly-stale server prop, so a successful autosave
  // clears the dirty flag without forcing a refetch.
  const lastServer = useRef(mixtape);
  const [savedFieldsSig, setSavedFieldsSig] = useState(() =>
    fieldsSignature(serverFieldValues(mixtape)),
  );
  const [savedMembersSig, setSavedMembersSig] = useState(() =>
    membersSignature(mixtape.members.map(toMemberRef)),
  );
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "error">("idle");
  const [autosaveError, setAutosaveError] = useState<string>();
  const autosaveInFlight = useRef(false);

  // Adopt an incoming server snapshot only when there are no unsaved local edits
  // (the whole local state still matches the snapshot we last saw). With autosave
  // that window is sub-second, so a focus refetch never clobbers work in progress;
  // when it does adopt, the saved-signatures reset to the new snapshot.
  useEffect(() => {
    const local = stateRef.current;
    const prev = lastServer.current;
    const noUnsavedEdits =
      fieldsSignature({
        durationMs: parseDuration(local.durationField),
        note: local.note,
        plannedFor: local.plannedFor,
        recordedAt: local.recordedAt,
        soundcloudUrl: local.soundcloudUrl,
      }) === fieldsSignature(serverFieldValues(prev)) &&
      membersSignature(local.members) === membersSignature(prev.members.map(toMemberRef));
    if (noUnsavedEdits) {
      setNote(mixtape.note ?? "");
      setRecordedAt(mixtape.recordedAt?.slice(0, 10) ?? "");
      setPlannedFor(toLocalDateTime(mixtape.plannedFor));
      setDurationField(formatDurationField(mixtape.durationMs));
      setSoundcloudUrl(mixtape.externalUrls.soundcloud ?? "");
      setMembers(mixtape.members.map(toMemberRef));
      setSavedFieldsSig(fieldsSignature(serverFieldValues(mixtape)));
      setSavedMembersSig(membersSignature(mixtape.members.map(toMemberRef)));
    }
    lastServer.current = mixtape;
  }, [mixtape]);

  const parsedDurationMs = parseDuration(durationField);
  const durationInvalid = durationField.trim().length > 0 && parsedDurationMs === null;
  const urlInvalid = !isOptionalHttpUrl(soundcloudUrl);
  const fieldsValid = !durationInvalid && !urlInvalid;

  const currentFieldsSig = fieldsSignature({
    durationMs: parsedDurationMs,
    note,
    plannedFor,
    recordedAt,
    soundcloudUrl,
  });
  const currentMembersSig = membersSignature(members);
  // Members are draft-only and the endpoint rejects empty arrays, so an emptied
  // tracklist is never autosaved (matching the server's own constraint).
  const membersChanged = !minted && members.length > 0 && currentMembersSig !== savedMembersSig;
  const dirty = currentFieldsSig !== savedFieldsSig || membersChanged;
  const canAutosave = dirty && fieldsValid && !busy && Boolean(mixtape.id);

  const autosave = async () => {
    if (autosaveInFlight.current || !mixtape.id) {
      return;
    }
    autosaveInFlight.current = true;
    setAutosaveStatus("saving");
    setAutosaveError(undefined);
    const id = mixtape.id;
    const fieldsSnapshot = currentFieldsSig;
    const membersSnapshot = currentMembersSig;
    const saveMembers = membersChanged;
    try {
      await saveMixtape(id, {
        durationMs: parsedDurationMs,
        note,
        plannedFor: fromLocalDateTime(plannedFor),
        recordedAt,
        soundcloudUrl,
      });
      if (saveMembers) {
        await replaceMembers(id, members);
      }
      setSavedFieldsSig(fieldsSnapshot);
      if (saveMembers) {
        setSavedMembersSig(membersSnapshot);
      }
      setAutosaveStatus("idle");
    } catch (caught) {
      setAutosaveError(caught instanceof Error ? caught.message : String(caught));
      setAutosaveStatus("error");
    } finally {
      autosaveInFlight.current = false;
    }
  };

  // Keep a live handle to autosave so the debounce effect fires the latest closure
  // without re-subscribing (and resetting the timer) on every render.
  const autosaveRef = useRef(autosave);
  useEffect(() => {
    autosaveRef.current = autosave;
  });

  // Debounced autosave: re-armed whenever the savable content changes, so a burst
  // of edits collapses into one write ~700ms after the operator stops typing.
  useEffect(() => {
    if (!canAutosave) {
      return;
    }
    const timer = window.setTimeout(() => void autosaveRef.current(), 700);
    return () => window.clearTimeout(timer);
  }, [canAutosave, currentFieldsSig, currentMembersSig]);

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
        {mixtape.logId ? (
          <span className="shrink-0 font-mono text-xs tracking-tight text-muted-foreground tabular-nums">
            {mixtape.logId}
          </span>
        ) : null}
        <Badge className="shrink-0" variant={minted ? "default" : "outline"}>
          {mixtape.status ?? "draft"}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-bold">
          {mixtape.logId ? mixtapeDisplayTitle(mixtape.title) : "Untitled mixtape"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {members.length} banger{members.length === 1 ? "" : "s"}
          {mixtape.durationMs ? ` · ${formatAlbumDuration(mixtape.durationMs)}` : ""}
        </span>
      </button>

      {expanded ? (
        <section aria-labelledby={headerId} className="px-4 pb-4 pt-2 sm:px-5" id={bodyId}>
          {minted ? (
            // A published checkpoint is read-only — a clean summary, not the editor:
            // the tracklist, where it's live, the dream note, and the public page.
            <div className="space-y-4">
              <MembersBuilder
                currentMixtapeId={mixtape.id}
                members={members}
                membershipByTrack={membershipByTrack}
                onChange={setMembers}
                published
              />

              {mixtape.id ? (
                <DistributionStrip mixtapeId={mixtape.id} status={mixtape.status} />
              ) : null}

              {note.trim() ? (
                <div className="space-y-1.5">
                  <Label>Note</Label>
                  <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                    {note}
                  </p>
                </div>
              ) : null}

              {mixtape.logId ? (
                <div className="flex items-center gap-3 border-t border-border pt-4">
                  <img
                    alt=""
                    className="size-12 shrink-0 rounded-md border border-border object-cover"
                    src={`/api/mixtape-cover/${encodeURIComponent(mixtape.logId)}?size=thumb`}
                  />
                  <a
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-ring"
                    href={`/log/${encodeURIComponent(mixtape.logId)}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    View the public log page ↗
                  </a>
                </div>
              ) : null}
            </div>
          ) : (
            // A draft is the editor: the tracklist (the centerpiece) plus the deferred
            // details and the CLI publish help.
            <>
              <MembersBuilder
                currentMixtapeId={mixtape.id}
                members={members}
                membershipByTrack={membershipByTrack}
                onChange={setMembers}
                published={false}
              />

              <details className="mt-4 rounded-lg border border-border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                  Details
                </summary>
                <div className="mt-3 space-y-3">
                  <Field
                    hint="Defaults to the day you distribute; set it only to backdate the coordinate's sector."
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
                  <div className="space-y-1.5">
                    <Label htmlFor={noteId}>Note</Label>
                    <Textarea
                      id={noteId}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      The dream note. Write it now or after publishing; it becomes the platform
                      descriptions and the /log prose.
                    </p>
                  </div>
                  <Field
                    hint={
                      isOptionalHttpUrl(soundcloudUrl)
                        ? "Optional — paste after a manual SoundCloud upload."
                        : "Must be a full http(s) URL."
                    }
                    invalid={!isOptionalHttpUrl(soundcloudUrl)}
                    label="SoundCloud URL"
                    value={soundcloudUrl}
                    onChange={setSoundcloudUrl}
                  />
                </div>
              </details>

              <details className="mt-3 rounded-lg border border-border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                  How to publish this mixtape
                </summary>
                <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                  <p>
                    A draft is just the tracklist. Publishing — minting the Log ID and cover, then
                    uploading to YouTube and Mixcloud — runs from the CLI, where your audio and
                    video files live:
                  </p>
                  <pre className="overflow-x-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
                    {`# mint + upload (YouTube unlisted, Mixcloud listed), flips it published
fluncle admin mixtapes distribute ${mixtape.id ?? "<id>"} --video <mp4> --audio <m4a>

# make the YouTube video public when you're ready
fluncle admin mixtapes publish-youtube ${mixtape.id ?? "<id>"}`}
                  </pre>
                  <p>
                    Add <code className="font-mono">--unlisted</code> to keep Mixcloud private for a
                    test run.
                  </p>
                </div>
              </details>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <AutosaveStatus
                  dirty={dirty}
                  error={autosaveError}
                  fieldsValid={fieldsValid}
                  onRetry={() => void autosave()}
                  status={autosaveStatus}
                />
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button className="ml-auto" disabled={busy} size="sm" variant="destructive">
                        <TrashIcon aria-hidden="true" />
                        Discard draft
                      </Button>
                    }
                  />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The draft and its tracklist will be permanently removed. This can't be
                        undone.
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
              </div>
            </>
          )}
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
        </section>
      ) : null}
    </section>
  );
}

// The per-platform distribution status for a minted mixtape: one row per platform
// (uploading / published / failed), a link once published, and the recurring
// unlisted→public flip for YouTube while the mixtape is still `distributing`. Read
// from /api/admin/mixtapes/:id/social with focus-refetch ON (admin convention) so
// the operator watches a CLI distribute run land without a manual reload.
// Proper platform names — CSS `capitalize` would render "Youtube", not "YouTube".
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
    <div className="space-y-2">
      <Label>Distribution</Label>
      {posts && posts.length > 0 ? (
        <div className="divide-y divide-border">
          {posts.map((post) => (
            <div key={post.platform} className="flex items-center gap-3 py-2">
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
  currentMixtapeId,
  members,
  membershipByTrack,
  onChange,
  published,
}: {
  currentMixtapeId?: string;
  members: MemberRef[];
  membershipByTrack: Map<string, MixtapeMembership[]>;
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

  if (published) {
    return (
      <div className="space-y-1.5">
        <Label>Tracklist</Label>
        <div className="divide-y divide-border">
          {members.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No bangers logged.</p>
          ) : (
            members.map((member) => (
              <div key={member.trackId} className="flex items-center gap-3 py-2">
                <MemberThumb src={member.albumImageUrl} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {member.artists.join(", ")} — {member.title}
                </span>
                <MemberMeta bpm={member.bpm} musicalKey={member.key} />
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
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label>Tracklist</Label>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">Search a banger to start the tracklist.</p>
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
      <MemberSearch
        currentMixtapeId={currentMixtapeId}
        membershipByTrack={membershipByTrack}
        onSelect={add}
        selected={members}
      />
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
      className={`flex items-center gap-2 py-2 ${isDragging ? "relative z-10 bg-muted" : ""}`}
      ref={setNodeRef}
      style={style}
    >
      <button
        aria-label={`Reorder ${member.title}`}
        className="inline-flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
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
      <MemberMeta bpm={member.bpm} musicalKey={member.key} />
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
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => onRemove(member.trackId)}
        type="button"
      >
        <XIcon aria-hidden="true" />
      </button>
    </li>
  );
}

function MemberSearch({
  currentMixtapeId,
  membershipByTrack,
  onSelect,
  selected,
}: {
  currentMixtapeId?: string;
  membershipByTrack: Map<string, MixtapeMembership[]>;
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
                {results.map((track) => {
                  // Tapes OTHER than the one being edited — the soft "already used"
                  // cue. Membership in the current draft is handled by selectedIds.
                  const otherTapes = (membershipByTrack.get(track.trackId) ?? []).filter(
                    (membership) => membership.mixtapeId !== currentMixtapeId,
                  );

                  return (
                    <CommandItem
                      key={track.trackId}
                      disabled={selectedIds.has(track.trackId)}
                      onSelect={() => onSelect(toTrackRef(track))}
                      value={track.trackId}
                    >
                      <MemberThumb src={track.albumImageUrl} />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          otherTapes.length > 0 ? "text-muted-foreground" : "",
                        )}
                      >
                        {track.artists.join(", ")} — {track.title}
                      </span>
                      <MemberMeta bpm={track.bpm} musicalKey={track.key} />
                      <MemberTapeBadge memberships={otherTapes} />
                      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {track.logId ?? track.trackId}
                      </span>
                    </CommandItem>
                  );
                })}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Tempo + key as one quiet line — the match-up signal when ordering a tape (a 174
// banger reads next to its neighbours). Tabular numerals like the Log ID column;
// nothing renders until enrichment has produced a BPM or a key.
function MemberMeta({ bpm, musicalKey }: { bpm?: number; musicalKey?: string }) {
  const parts = [bpm ? `${Math.round(bpm)} BPM` : undefined, musicalKey].filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{parts.join(" · ")}</span>
  );
}

function MemberThumb({ src }: { src?: string }) {
  if (src) {
    return (
      <img
        alt=""
        className="size-8 shrink-0 rounded-sm border border-border object-cover"
        src={spotifyAlbumImageAtSize(src, "small")}
      />
    );
  }
  return <div className="track-artwork-fallback size-8 shrink-0 rounded-sm border border-border" />;
}

// The "already on a tape" cue in the track search — keeps mixtapes largely unique
// without blocking a deliberate re-use. A gold cassette chip listing the other
// tapes (count when more than one); absent for a fresh banger.
function MemberTapeBadge({ memberships }: { memberships: MixtapeMembership[] }) {
  if (memberships.length === 0) {
    return null;
  }

  const titles = memberships
    .map((membership) => {
      const name = mixtapeDisplayTitle(membership.title) || "Draft";
      return membership.logId ? `${membership.logId} · ${name}` : name;
    })
    .join("\n");

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-primary tabular-nums"
      title={titles}
    >
      <CassetteTapeIcon className="size-3" weight="fill" />
      {memberships.length > 1 ? memberships.length : null}
    </span>
  );
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

// The draft's only "save" surface: it persists continuously, so this just reports
// where that stands — saving, saved, blocked by a field error, or failed with a
// retry. A focused field error is surfaced inline; this stays a quiet summary.
function AutosaveStatus({
  dirty,
  error,
  fieldsValid,
  onRetry,
  status,
}: {
  dirty: boolean;
  error?: string;
  fieldsValid: boolean;
  onRetry: () => void;
  status: "idle" | "saving" | "error";
}) {
  if (status === "error") {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        <span role="alert">Couldn't save{error ? `: ${error}` : "."}</span>
        <Button onClick={onRetry} size="sm" variant="outline">
          Retry save
        </Button>
      </span>
    );
  }
  if (dirty && !fieldsValid) {
    return <span className="text-xs text-muted-foreground">Unsaved. Fix the errors above.</span>;
  }
  if (status === "saving" || dirty) {
    return (
      <span aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
        Saving…
      </span>
    );
  }
  return (
    <span aria-live="polite" className="text-xs text-muted-foreground">
      All changes saved.
    </span>
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

function subscribeReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
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
    bpm: member.bpm,
    durationMs: member.durationMs,
    key: member.key,
    logId: member.logId,
    title: member.title,
    trackId: member.trackId,
  };
}

function toTrackRef(track: TrackListItem): MemberRef {
  return {
    albumImageUrl: track.albumImageUrl,
    artists: track.artists,
    bpm: track.bpm,
    durationMs: track.durationMs,
    key: track.key,
    logId: track.logId,
    title: track.title,
    trackId: track.trackId,
  };
}

// The savable scalar fields, normalized for change detection. Duration is keyed by
// its parsed millisecond value (not the raw field text) so "1:00" and "60" read as
// equal, matching what the server stores.
type FieldValues = {
  durationMs: number | null;
  note: string;
  plannedFor: string;
  recordedAt: string;
  soundcloudUrl: string;
};

function fieldsSignature(values: FieldValues): string {
  return JSON.stringify([
    values.durationMs,
    values.note,
    values.plannedFor,
    values.recordedAt,
    values.soundcloudUrl,
  ]);
}

// The tracklist's identity is its ordered Log IDs (falling back to trackId), so a
// reorder or add/remove changes the signature but a re-fetch of the same set does
// not.
function membersSignature(members: MemberRef[]): string {
  return members.map((member) => member.logId ?? member.trackId).join("\n");
}

// The server's view of a mixtape as FieldValues. Duration round-trips through the
// same format/parse the editor uses, so an untouched draft reads as not-dirty.
function serverFieldValues(mixtape: MixtapeDTO): FieldValues {
  return {
    durationMs: parseDuration(formatDurationField(mixtape.durationMs)),
    note: mixtape.note ?? "",
    plannedFor: toLocalDateTime(mixtape.plannedFor),
    recordedAt: mixtape.recordedAt?.slice(0, 10) ?? "",
    soundcloudUrl: mixtape.externalUrls.soundcloud ?? "",
  };
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

async function deleteMixtape(id: string) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
