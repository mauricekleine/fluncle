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
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  DotsSixVerticalIcon,
  FilmSlateIcon,
  ScissorsIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type RecordingDTO } from "@fluncle/contracts/orpc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
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
import { siBeatport } from "simple-icons";
import { AdminShell } from "@/components/admin/admin-shell";
import { FindingIdentity, TrackMetaChips } from "@/components/admin/finding-identity";
import { BrandIcon } from "@/components/brand-icon";
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
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@fluncle/ui/components/command";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@fluncle/ui/components/empty";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@fluncle/ui/components/popover";
import { beatportSearchUrl } from "@/lib/beatport";
import { formatAlbumDuration } from "@/lib/format";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listClips } from "@/lib/server/clips";
import { getRecordingCues, listRecordings } from "@/lib/server/recordings";
import { getTracksByIds, type TrackListItem } from "@/lib/server/tracks";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

// The PLAN editor (RFC plan→recording→mixtape §8, surface 1). A PLAN is a videoless
// `recordings` row (kind=plan, `r2Key` NULL): the operator lines up the findings for an
// upcoming set and carries the plan's handle onto Beatport / Rekordbox / a USB stick. A
// captured set is a TAKE (a recording that owns a video); a take attaches to its plan and
// is clipped + promoted in the Studio. This surface renamed from `/admin/mixtapes` — the
// old draft-mixtape editor's publish-time cruft (recorded date, dream note, SoundCloud,
// the CLI publish panel) belongs to the PUBLISHED mixtape, not the plan.
//
// Reads run SERVER-SIDE (createServerFn calling the server helpers in-process — no
// cross-origin fetch, no CORS); writes go through the operator-tier oRPC routes at
// `/api/v1/admin/recordings/*`. The findings builder + live session autosave; attaching a
// take is one click.

const PLANS_KEY = ["admin", "plans"] as const;

// The cover-render row a plan's findings builder keeps — a finding hydrated from its cue's
// `finding_id`. Mirrors the mixtape builder's member shape so the row renders identically.
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

// A plan and its hydrated findings — the loader resolves each cue's `finding_id` to a live
// finding so the builder renders rich rows (cover, BPM, key) after a reload.
type PlanView = { members: MemberRef[]; recording: RecordingDTO };

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// Every plan with its findings hydrated, every take (to attach + list), and the per-take
// clip count. In-process: no HTTP, no CORS. Cues carry only text + a `finding_id`, so this
// resolves each `finding_id` to a live finding (one batched query across every plan).
const fetchPlans = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    clipCounts: Record<string, number>;
    plans: PlanView[];
    takes: RecordingDTO[];
  }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const [plans, takes, clips] = await Promise.all([
      listRecordings({ kind: "plan" }),
      listRecordings({ kind: "take" }),
      listClips(),
    ]);

    // Read each plan's cues (with `finding_id`, which the DTO tracklist drops), then
    // hydrate every referenced finding in ONE batched query.
    const cuesByPlan = new Map(
      await Promise.all(
        plans.map(async (plan) => [plan.id, await getRecordingCues(plan.id)] as const),
      ),
    );
    const findingIds = [...cuesByPlan.values()]
      .flat()
      .map((cue) => cue.finding_id)
      .filter((id): id is string => Boolean(id));
    const tracksById = await getTracksByIds(findingIds);

    const planViews: PlanView[] = plans.map((recording) => {
      const cues = cuesByPlan.get(recording.id) ?? [];
      const members = cues.flatMap((cue): MemberRef[] => {
        const track = cue.finding_id ? tracksById[cue.finding_id] : undefined;

        return track ? [toMemberRef(track)] : [];
      });

      return { members, recording };
    });

    const clipCounts: Record<string, number> = {};

    for (const clip of clips) {
      if (clip.recordingId) {
        clipCounts[clip.recordingId] = (clipCounts[clip.recordingId] ?? 0) + 1;
      }
    }

    return { clipCounts, plans: planViews, takes };
  },
);

export const Route = createFileRoute("/admin/plans")({
  beforeLoad: () => ensureAdmin(),
  component: AdminPlansPage,
  loader: () => fetchPlans(),
});

function AdminPlansPage() {
  const initial = Route.useLoaderData();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useAutoNotice();
  const [error, setError] = useAutoNotice();
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchPlans(),
    queryKey: PLANS_KEY,
    refetchOnWindowFocus: true,
  });

  const { clipCounts, plans, takes } = data;

  // The loose takes a plan can adopt: a captured set not yet attached to any plan. Computed
  // once here so every plan's "Attach a take" picker offers the same pool.
  const looseTakes = useMemo(() => takes.filter((take) => !take.parentId), [takes]);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: PLANS_KEY }),
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

  const createPlan = async () => {
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch("/api/v1/admin/recordings", {
        body: JSON.stringify({ kind: "plan" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = (await response.json()) as { recording?: { id?: string } };
      const newId = body.recording?.id;
      await refresh();
      if (newId) {
        setExpanded((prev) => new Set(prev).add(newId));
      }
      setNotice("Playlist started. Line up the findings.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <AdminShell
      headerActions={
        <Button disabled={creating} onClick={() => void createPlan()} size="sm">
          {creating ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          ) : undefined}
          {creating ? "Starting…" : "New playlist"}
        </Button>
      }
      title="Playlists"
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

        {plans.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No playlists yet</EmptyTitle>
              <EmptyDescription>
                Start a plan to line up the findings for a set. It gets a handle you carry onto
                Beatport, Rekordbox, and the USB.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {plans.map((plan) => (
              <PlanEditor
                key={plan.recording.id}
                clipCounts={clipCounts}
                expanded={expanded.has(plan.recording.id)}
                looseTakes={looseTakes}
                onToggle={() => toggleExpanded(plan.recording.id)}
                plan={plan}
                refresh={refresh}
                takes={takes}
              />
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function PlanEditor({
  clipCounts,
  expanded,
  looseTakes,
  onToggle,
  plan,
  refresh,
  takes,
}: {
  clipCounts: Record<string, number>;
  expanded: boolean;
  looseTakes: RecordingDTO[];
  onToggle: () => void;
  plan: PlanView;
  refresh: () => Promise<void>;
  takes: RecordingDTO[];
}) {
  const headerId = useId();
  const bodyId = useId();
  const recording = plan.recording;
  const [plannedFor, setPlannedFor] = useState(() => toLocalDateTime(recording.plannedFor));
  const [members, setMembers] = useState<MemberRef[]>(plan.members);
  const [error, setError] = useAutoNotice();
  const [busy, setBusy] = useState(false);

  // A plan's own takes (this plan's children), newest first via the server order.
  const planTakes = useMemo(
    () => takes.filter((take) => take.parentId === recording.id),
    [recording.id, takes],
  );

  const stateRef = useRef({ members, plannedFor });
  useEffect(() => {
    stateRef.current = { members, plannedFor };
  });

  // Adopt an incoming server snapshot only when there are no unsaved local edits (the whole
  // local state still matches what we last saved). Autosave makes that window sub-second, so
  // a focus refetch never clobbers work in progress.
  const lastServer = useRef(recording);
  const [savedSig, setSavedSig] = useState(() => planSignature(recording.plannedFor, plan.members));
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "error">("idle");
  const [autosaveError, setAutosaveError] = useState<string>();
  const autosaveInFlight = useRef(false);

  const lastMembers = useRef(plan.members);
  useEffect(() => {
    const local = stateRef.current;
    const prev = lastServer.current;
    const noUnsavedEdits =
      planSignature(fromLocalDateTime(local.plannedFor), local.members) ===
      planSignature(prev.plannedFor, lastMembers.current);
    if (noUnsavedEdits) {
      setPlannedFor(toLocalDateTime(plan.recording.plannedFor));
      setMembers(plan.members);
      setSavedSig(planSignature(plan.recording.plannedFor, plan.members));
    }
    lastServer.current = plan.recording;
    lastMembers.current = plan.members;
  }, [plan]);

  const currentSig = planSignature(fromLocalDateTime(plannedFor), members);
  const dirty = currentSig !== savedSig;
  const canAutosave = dirty && !busy;

  const autosave = async () => {
    if (autosaveInFlight.current) {
      return;
    }
    autosaveInFlight.current = true;
    setAutosaveStatus("saving");
    setAutosaveError(undefined);
    const snapshot = currentSig;
    const savedPlanned = lastSavedPlanned(savedSig);
    const savedMembers = lastSavedMembers(savedSig);
    const nextPlanned = fromLocalDateTime(plannedFor);
    try {
      // Save only what changed — the live session (a PATCH) and the findings (a cue
      // replace) live on separate ops.
      if (nextPlanned !== savedPlanned) {
        await patchRecording(recording.id, { plannedFor: nextPlanned });
      }
      if (membersSignature(members) !== savedMembers) {
        await replaceCues(recording.id, members);
      }
      setSavedSig(snapshot);
      setAutosaveStatus("idle");
    } catch (caught) {
      setAutosaveError(caught instanceof Error ? caught.message : String(caught));
      setAutosaveStatus("error");
    } finally {
      autosaveInFlight.current = false;
    }
  };

  const autosaveRef = useRef(autosave);
  useEffect(() => {
    autosaveRef.current = autosave;
  });

  useEffect(() => {
    if (!canAutosave) {
      return;
    }
    const timer = window.setTimeout(() => void autosaveRef.current(), 700);
    return () => window.clearTimeout(timer);
  }, [canAutosave, currentSig]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const attachTake = (takeId: string) =>
    run(async () => {
      await patchRecording(takeId, { parentId: recording.id });
    });

  const discard = () =>
    run(async () => {
      await deleteRecording(recording.id);
    });

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
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium tracking-tight">
          {recording.title}
        </span>
        {planTakes.length > 0 ? (
          <Badge className="shrink-0" variant="outline">
            {planTakes.length} take{planTakes.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {members.length} banger{members.length === 1 ? "" : "s"}
        </span>
      </button>

      {expanded ? (
        <section
          aria-labelledby={headerId}
          className="space-y-4 px-4 pb-4 pt-2 sm:px-5"
          id={bodyId}
        >
          <PlanHandleField handle={recording.title} />

          <MembersBuilder members={members} onChange={setMembers} />

          <Field
            hint="The date of the upcoming set. It shows on the calendar feed. Clear to hide."
            label="Live session"
            type="datetime-local"
            value={plannedFor}
            onChange={setPlannedFor}
          />

          <AttachTake
            clipCounts={clipCounts}
            looseTakes={looseTakes}
            onAttach={(id) => void attachTake(id)}
            planTakes={planTakes}
          />

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <AutosaveStatus
              dirty={dirty}
              error={autosaveError}
              onRetry={() => void autosave()}
              status={autosaveStatus}
            />
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button className="ml-auto" disabled={busy} size="sm" variant="destructive">
                    <TrashIcon aria-hidden="true" />
                    Discard plan
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Discard this playlist?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The plan and its tracklist will be permanently removed. This can't be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>Keep playlist</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={busy}
                    onClick={() => void discard()}
                    variant="destructive"
                  >
                    {busy ? (
                      <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                    ) : undefined}
                    {busy ? "Discarding…" : "Discard playlist"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

// The plan's handle — the auto Galaxy-vocab slug the operator carries onto Beatport,
// Rekordbox, and the USB. Read-only, one-tap copyable, rendered body/mono (a label you
// paste, not a coordinate — so it is NOT the Oxanium numeral of a Log ID).
function PlanHandleField({ handle }: { handle: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(handle).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="space-y-1.5">
      <Label>Playlist handle</Label>
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm tracking-tight text-foreground">{handle}</span>
        <Button aria-label="Copy the playlist handle" onClick={copy} size="sm" variant="outline">
          {copied ? (
            <CheckIcon aria-hidden="true" className="text-primary" weight="bold" />
          ) : (
            <CopyIcon aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The name this plan carries. Copy it onto your Beatport playlist, Rekordbox crate, and USB
        folders. It's fixed, so it won't drift like a date.
      </p>
    </div>
  );
}

// "Attach a take" (RFC §8, surface 2 — the CLI-upload-then-attach cut, R2 CORS pending): a
// take is a captured set uploaded from the CLI. This picks a loose take (one not yet on any
// plan) and attaches it, then lists this plan's takes with their version, promoted state,
// clip count, and a link into the Studio.
function AttachTake({
  clipCounts,
  looseTakes,
  onAttach,
  planTakes,
}: {
  clipCounts: Record<string, number>;
  looseTakes: RecordingDTO[];
  onAttach: (takeId: string) => void;
  planTakes: RecordingDTO[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        <FilmSlateIcon aria-hidden="true" />
        Takes
      </Label>

      {planTakes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No takes yet. Record the set, upload it from the CLI (
          <code className="font-mono text-xs">fluncle admin recordings create --video set.mov</code>
          ), then attach it here.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {planTakes.map((take) => (
            <TakeRow clipCount={clipCounts[take.id] ?? 0} key={take.id} take={take} />
          ))}
        </ul>
      )}

      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          render={
            <Button className="w-full justify-start" variant="outline">
              Attach a take…
            </Button>
          }
        />
        <PopoverContent align="start" className="w-(--anchor-width) p-0">
          <Command>
            <CommandInput placeholder="Search a loose take by handle" />
            <CommandList>
              {looseTakes.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No loose takes to attach. Upload one from the CLI first.
                </p>
              ) : (
                <>
                  <CommandEmpty>No takes match.</CommandEmpty>
                  {looseTakes.map((take) => (
                    <CommandItem
                      key={take.id}
                      onSelect={() => {
                        onAttach(take.id);
                        setOpen(false);
                      }}
                      value={`${take.title} ${take.id}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">
                        {take.title}
                      </span>
                      {take.logId ? (
                        <Badge variant="secondary">promoted</Badge>
                      ) : (
                        <Badge variant="outline">take</Badge>
                      )}
                    </CommandItem>
                  ))}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// One take under a plan (the RecordingsIndex row, plan-scoped): its version label, promoted
// state (`fluncle://<logId>` once a mixtape was minted from it, else "take"), clip count, and
// the link into the Studio to clip + promote it.
function TakeRow({ clipCount, take }: { clipCount: number; take: RecordingDTO }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        v{take.version}
      </span>
      <Link
        className="min-w-0 flex-1 truncate text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
        params={{ recordingId: take.id }}
        to="/admin/studio/$recordingId"
      >
        {take.title}
      </Link>
      {take.logId ? (
        <Badge variant="secondary">promoted · fluncle://{take.logId}</Badge>
      ) : (
        <Badge variant="outline">take</Badge>
      )}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {clipCount} clip{clipCount === 1 ? "" : "s"}
      </span>
      <Button
        aria-label={`Open ${take.title} in the Studio`}
        className="text-muted-foreground"
        nativeButton={false}
        render={<Link params={{ recordingId: take.id }} to="/admin/studio/$recordingId" />}
        size="icon"
        title="Open in Studio"
        variant="ghost"
      >
        <ScissorsIcon aria-hidden="true" />
      </Button>
    </li>
  );
}

// The findings builder — search a banger, drag to reorder, remove. Ported verbatim from the
// mixtape builder (the plan's tracklist is the set you'll play). Order + membership is the
// whole edit; timing (cue start times) is marked later on the TAKE, in the Studio.
function MembersBuilder({
  members,
  onChange,
}: {
  members: MemberRef[];
  onChange: Dispatch<SetStateAction<MemberRef[]>>;
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
      <MemberSearch onSelect={add} selected={members} />
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
      <FindingIdentity
        artists={member.artists}
        className="flex-1"
        cover={member.albumImageUrl}
        coverVariant="art"
        size="xs"
        title={member.title}
        titleFormat="inline"
      />
      <TrackMetaChips bpm={member.bpm} musicalKey={member.key} />
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
      <Button
        aria-label={`Search ${member.title} on Beatport`}
        className="text-muted-foreground"
        nativeButton={false}
        render={
          <a
            href={beatportSearchUrl(member.artists, member.title)}
            rel="noreferrer"
            target="_blank"
          />
        }
        size="icon"
        title="Search on Beatport"
        variant="ghost"
      >
        <BrandIcon className="size-4" icon={siBeatport} />
      </Button>
      <Button
        aria-label={`Remove ${member.title}`}
        className="text-muted-foreground hover:text-destructive"
        onClick={() => onRemove(member.trackId)}
        size="icon"
        variant="ghost"
      >
        <XIcon aria-hidden="true" />
      </Button>
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
                    onSelect={() => onSelect(toMemberRef(track))}
                    value={track.trackId}
                  >
                    <FindingIdentity
                      artists={track.artists}
                      className="flex-1"
                      cover={track.albumImageUrl}
                      coverVariant="art"
                      size="xs"
                      title={track.title}
                      titleFormat="inline"
                    />
                    <TrackMetaChips bpm={track.bpm} musicalKey={track.key} />
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

function Field({
  hint,
  id: providedId,
  label,
  onChange,
  type,
  value,
}: {
  hint?: ReactNode;
  id?: string;
  label: string;
  onChange: (value: string) => void;
  type?: string;
  value: string;
}) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// The plan's only "save" surface: it persists continuously, so this just reports where that
// stands — saving, saved, or failed with a retry.
function AutosaveStatus({
  dirty,
  error,
  onRetry,
  status,
}: {
  dirty: boolean;
  error?: string;
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

// An ISO instant → the `datetime-local` input's value (local wall-clock, minute precision).
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

// The `datetime-local` value (local wall-clock) → an ISO instant for the API. Empty string
// clears the field (server stores null).
function fromLocalDateTime(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function toMemberRef(track: TrackListItem): MemberRef {
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

// The findings' identity is their ordered trackIds, so a reorder or add/remove changes the
// signature but a re-fetch of the same set does not.
function membersSignature(members: MemberRef[]): string {
  return members.map((member) => member.trackId).join("\n");
}

// One string capturing both savable halves — the live session (normalized to its ISO
// instant) and the ordered findings — so the dirty check and the last-saved decode read the
// same value.
function planSignature(plannedForIso: string | undefined, members: MemberRef[]): string {
  return JSON.stringify([plannedForIso ?? "", membersSignature(members)]);
}

function lastSavedPlanned(signature: string): string {
  const [planned] = JSON.parse(signature) as [string, string];
  return planned;
}

function lastSavedMembers(signature: string): string {
  const [, membersSig] = JSON.parse(signature) as [string, string];
  return membersSig;
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
  const response = await fetch(`/api/v1/admin/tracks?q=${encodeURIComponent(q)}&limit=20`);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { tracks?: TrackListItem[] };
  return body.tracks ?? [];
}

// PATCH a recording (the plan's live session, or a take's plan link). Operator-tier oRPC.
async function patchRecording(id: string, body: { parentId?: string; plannedFor?: string }) {
  const response = await fetch(`/api/v1/admin/recordings/${encodeURIComponent(id)}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

// Replace the plan's cues (its findings) — each finding's `trackId` is the cue's honest
// `finding_id`. Operator-tier oRPC (`replace_recording_cues`); positions reindex from order.
async function replaceCues(id: string, members: MemberRef[]) {
  const response = await fetch(`/api/v1/admin/recordings/${encodeURIComponent(id)}/cues`, {
    body: JSON.stringify({
      cues: members.map((member, index) => ({
        artistsText: member.artists.join(", "),
        findingId: member.trackId,
        position: index + 1,
        titleText: member.title,
      })),
    }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function deleteRecording(id: string) {
  const response = await fetch(`/api/v1/admin/recordings/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
