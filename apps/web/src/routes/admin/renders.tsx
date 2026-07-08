import {
  ArrowsClockwiseIcon,
  BroomIcon,
  CircleNotchIcon,
  DotsThreeVerticalIcon,
  FilmReelIcon,
} from "@phosphor-icons/react";
import { type TrackListItem } from "@fluncle/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Dispatch, type ReactNode, type SetStateAction, useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { FindingIdentity } from "@/components/admin/finding-identity";
import { ObjectList, ObjectRow } from "@/components/admin/object-row";
import { StoriesPlayer } from "@/components/stories/stories-player";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fluncle/ui/components/alert-dialog";
import { Badge } from "@fluncle/ui/components/badge";
import { Dialog, DialogContent } from "@fluncle/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { Empty } from "@fluncle/ui/components/empty";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { type ServiceHealthStatus, getServiceStatuses } from "@/lib/server/status";
import { listRecentlyRenderedFindings, listTracks } from "@/lib/server/tracks";

// The admin Renders view (docs/admin-shell.md) — the web control plane for the
// video render pipeline that was otherwise CLI/box-only. Three surfaces, top to
// bottom, so the operator reads the machine, the backlog, then the output:
//
//   1. Box state — the render conductor cron (`cron.render`) and the scale-to-zero
//      box (`render-box`) as data, read from the SAME `service_status` store /status
//      shows (no new probe invented). Their last-report freshness is the machine's pulse.
//   2. The queue — findings awaiting a video (the box's own `fluncle admin tracks
//      queue` read: hasContext && !hasVideo, oldest-first). The head is next to film.
//   3. Recently shipped — the freshest renders (by video vintage), the operator's
//      morning review. Each carries [Watch] + the two operator-tier render controls
//      (Requeue, Purge), both destructive → behind a confirm.
//
// Every write reuses the LIVE oRPC ops the CLI hits (POST .../video/requeue|purge),
// not a fork. Reads run server-side (createServerFn, in-process, no CORS), then
// refetch on focus + after a write so a requeued finding is seen to move lists.

const QUEUE_LIMIT = 60;
const SHIPPED_LIMIT = 24;

const RENDERS_KEY = ["admin", "renders"] as const;
// The sidebar's render-backlog badge reads this key; invalidate it after a requeue so
// the count re-reads honest without a reload.
const NAV_COUNTS_KEY = ["admin", "nav", "counts"] as const;

// The render conductor + box as the /status store carries them: the last-report
// freshness IS the pulse (a cron is health-checked by its last run). Null when the
// prober hasn't reported that service yet.
type BoxService = {
  checkedAt: string;
  message: string | null;
  since: string;
  status: ServiceHealthStatus;
} | null;

type RendersData = {
  box: { conductor: BoxService; renderBox: BoxService };
  // The loader's fixed reference instant, so a server-rendered "waiting 3h" matches
  // hydration exactly (no client clock drift) and re-reads live on every refetch.
  now: string;
  queue: TrackListItem[];
  queueTotal: number;
  shipped: TrackListItem[];
};

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchRenders = createServerFn({ method: "GET" }).handler(async (): Promise<RendersData> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  const [queuePage, shipped, services] = await Promise.all([
    // The box's canonical render queue read (fluncle admin tracks queue): context'd
    // findings still needing a video, oldest-first — the next to film is the head.
    listTracks({ hasContext: true, hasVideo: false, limit: QUEUE_LIMIT, order: "asc" }),
    listRecentlyRenderedFindings(SHIPPED_LIMIT),
    getServiceStatuses(),
  ]);

  const pick = (service: string): BoxService => {
    const row = services.find((entry) => entry.service === service);

    return row
      ? { checkedAt: row.checked_at, message: row.message, since: row.since, status: row.status }
      : null;
  };

  return {
    box: { conductor: pick("cron.render"), renderBox: pick("render-box") },
    now: new Date().toISOString(),
    queue: queuePage.tracks,
    queueTotal: queuePage.totalCount,
    shipped,
  };
});

export const Route = createFileRoute("/admin/renders")({
  beforeLoad: () => ensureAdmin(),
  component: RendersPage,
  loader: async () => ({ renders: await fetchRenders() }),
});

type ConfirmTarget = { kind: "purge" | "requeue"; track: TrackListItem };

function RendersPage() {
  const { renders: initial } = Route.useLoaderData();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchRenders(),
    queryKey: RENDERS_KEY,
    refetchOnWindowFocus: true,
  });

  const [watch, setWatch] = useState<TrackListItem | undefined>();
  const [confirm, setConfirm] = useState<ConfirmTarget | undefined>();
  const [notice, setNotice] = useAutoNotice();
  const [error, setError] = useAutoNotice();

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: RENDERS_KEY }),
      queryClient.invalidateQueries({ queryKey: NAV_COUNTS_KEY }),
    ]);
  };

  const requeue = useMutation({
    mutationFn: (track: TrackListItem) => postVideoAction(track.trackId, "requeue"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSettled: () => setConfirm(undefined),
    onSuccess: async () => {
      setNotice("Requeued. Back in the render queue.");
      await refresh();
    },
  });

  const purge = useMutation({
    mutationFn: (track: TrackListItem) => postVideoAction(track.trackId, "purge"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSettled: () => setConfirm(undefined),
    onSuccess: async () => {
      setNotice("Purged the cached edge renditions.");
      await refresh();
    },
  });

  const pending = requeue.isPending || purge.isPending;

  const onConfirm = () => {
    if (!confirm) {
      return;
    }

    if (confirm.kind === "requeue") {
      requeue.mutate(confirm.track);
    } else {
      purge.mutate(confirm.track);
    }
  };

  const subtitle = `${data.queueTotal} awaiting · ${data.shipped.length} recent`;

  return (
    <AdminShell subtitle={subtitle} title="Renders">
      <div className="space-y-8 p-4 sm:p-5">
        <BoxState box={data.box} now={data.now} />

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

        <QueueSection now={data.now} queue={data.queue} total={data.queueTotal} />

        <ShippedSection
          now={data.now}
          onPurge={(track) => setConfirm({ kind: "purge", track })}
          onRequeue={(track) => setConfirm({ kind: "requeue", track })}
          onWatch={setWatch}
          shipped={data.shipped}
        />
      </div>

      {/* One controlled confirm for both destructive controls — the consequences read
          as a deadpan two-item list (data, not narration), and the finding it acts on
          is named in the dialog description. */}
      <ConfirmDialog
        onConfirm={onConfirm}
        onOpenChange={(open) => !open && !pending && setConfirm(undefined)}
        pending={pending}
        target={confirm}
      />

      {/* Watch — the same single-clip Stories UI the board's preview uses. */}
      <Dialog onOpenChange={(open) => !open && setWatch(undefined)} open={watch !== undefined}>
        <DialogContent
          aria-label="Render preview"
          className="inset-0 top-0 left-0 block h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-transparent p-0 ring-0 sm:max-w-none"
          showCloseButton={false}
        >
          {watch ? (
            <StoriesPlayer
              initialLogId={watch.logId ?? undefined}
              onClose={() => setWatch(undefined)}
              onStoryChange={() => {}}
              presentation="dialog"
              tracks={[watch]}
            />
          ) : undefined}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

// The render machine as data — the conductor cron's last run + the scale-to-zero
// box's reachability, both from the /status store. Two quiet cells so the operator
// reads the pulse before the backlog it drains.
function BoxState({ box, now }: { box: RendersData["box"]; now: string }) {
  return (
    <section aria-label="Render machine">
      <div className="grid gap-3 sm:grid-cols-2">
        <BoxCell
          hint="the conductor's last run"
          now={now}
          service={box.conductor}
          title="Render cron"
        />
        <BoxCell
          hint="the scale-to-zero box's reachability"
          now={now}
          service={box.renderBox}
          title="Render box"
        />
      </div>
    </section>
  );
}

function BoxCell({
  hint,
  now,
  service,
  title,
}: {
  hint: string;
  now: string;
  service: BoxService;
  title: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card/60 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {service?.message?.trim() ? service.message : hint}
        </p>
        {service ? (
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            reported {elapsedShort(service.checkedAt, now)} ago
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">no report yet</p>
        )}
      </div>
      <StatusIndicator status={service?.status ?? null} />
    </div>
  );
}

const STATUS_LABEL: Record<ServiceHealthStatus, string> = {
  degraded: "Degraded",
  down: "Down",
  ok: "Operational",
};

// The canon status indicator (DESIGN.md — no green; The One Sun caps gold; escalate
// by loudness so the eye lands on trouble): ok is a calm gold ping, degraded the
// Eclipse-Glow amber chip, down the Re-entry-Red destructive badge. Null (never
// probed) reads as a quiet muted chip.
function StatusIndicator({ status }: { status: ServiceHealthStatus | null }) {
  if (status === null) {
    return (
      <Badge className="shrink-0" variant="outline">
        No report
      </Badge>
    );
  }

  if (status === "down") {
    return (
      <Badge className="shrink-0" variant="destructive">
        {STATUS_LABEL.down}
      </Badge>
    );
  }

  if (status === "degraded") {
    return (
      <Badge className="shrink-0 border-transparent bg-[#ffd057]/15 text-[#ffd057]">
        {STATUS_LABEL.degraded}
      </Badge>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="relative flex size-1.5">
        <span
          aria-hidden
          className="absolute inline-flex size-full rounded-full bg-primary opacity-60 motion-safe:animate-ping"
        />
        <span aria-hidden className="relative inline-flex size-1.5 rounded-full bg-primary" />
      </span>
      {STATUS_LABEL.ok}
    </span>
  );
}

// The queue — findings awaiting a video, oldest-first. Data only (there is no video
// to act on yet); the head-of-queue is marked "Next up" (the one gold accent). The
// context gate that admitted every row is shown as an honest chip.
function QueueSection({
  now,
  queue,
  total,
}: {
  now: string;
  queue: TrackListItem[];
  total: number;
}) {
  return (
    <section aria-label="Render queue">
      <SectionHeading count={total} label="Awaiting a video" />
      {queue.length === 0 ? (
        <EmptyRow>Queue’s clear. Nothing’s waiting on the box.</EmptyRow>
      ) : (
        <ObjectList>
          {queue.map((track, index) => (
            <RenderRow
              key={track.trackId}
              track={track}
              trailing={
                <>
                  {index === 0 ? (
                    <Badge
                      className="border-primary/40 bg-primary/10 text-primary"
                      variant="outline"
                    >
                      Next up
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground tabular-nums">#{index + 1}</span>
                  )}
                  <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                    waiting {elapsedShort(track.addedAt, now)}
                  </span>
                  <Badge className="hidden text-muted-foreground sm:inline-flex" variant="outline">
                    context ready
                  </Badge>
                </>
              }
            />
          ))}
        </ObjectList>
      )}
    </section>
  );
}

// Recently shipped — the freshest renders (by vintage), the morning review. Each
// carries its diversity ledger (vehicle · grain · register) + vintage, then the
// controls: Watch, Requeue, Purge.
function ShippedSection({
  now,
  onPurge,
  onRequeue,
  onWatch,
  shipped,
}: {
  now: string;
  onPurge: (track: TrackListItem) => void;
  onRequeue: (track: TrackListItem) => void;
  onWatch: (track: TrackListItem) => void;
  shipped: TrackListItem[];
}) {
  return (
    <section aria-label="Recently shipped renders">
      <SectionHeading count={shipped.length} label="Recently shipped" />
      {shipped.length === 0 ? (
        <EmptyRow>No renders shipped yet.</EmptyRow>
      ) : (
        <ObjectList>
          {shipped.map((track) => (
            <RenderRow
              key={track.trackId}
              onWatch={onWatch}
              track={track}
              trailing={
                <>
                  <div className="flex flex-col items-end gap-0.5">
                    <Ledger track={track} />
                    {track.videoSquaredAt ? (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {elapsedShort(track.videoSquaredAt, now)} ago
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">legacy cut</span>
                    )}
                  </div>
                  <RenderActionsMenu
                    onPurge={() => onPurge(track)}
                    onRequeue={() => onRequeue(track)}
                    title={track.title}
                  />
                </>
              }
            />
          ))}
        </ObjectList>
      )}
    </section>
  );
}

// The diversity ledger the next video agent reads to diversify away from — vehicle,
// grain, register — as a quiet middle-dot line (absent parts drop out).
function Ledger({ track }: { track: TrackListItem }) {
  const parts = [track.videoVehicle, track.videoGrain, track.videoRegister].filter(
    (part): part is string => Boolean(part?.trim()),
  );

  if (parts.length === 0) {
    return null;
  }

  return <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>;
}

// A finding's identity block plus the shared Object Row shell. The identity is the shared
// FindingIdentity; on a shipped render `onWatch` makes the cover itself the play affordance
// (the gold story-ring + play badge — the same cover-as-play the findings board uses), so
// there is no separate Watch button. A queue row has no clip yet, so its cover stays inert.
function RenderRow({
  onWatch,
  track,
  trailing,
}: {
  onWatch?: (track: TrackListItem) => void;
  track: TrackListItem;
  trailing?: ReactNode;
}) {
  return (
    <ObjectRow trailing={trailing}>
      <FindingIdentity
        artists={track.artists}
        className="grow basis-full sm:basis-0"
        cover={track.albumImageUrl}
        hasClip={Boolean(onWatch)}
        logId={track.logId ?? undefined}
        onPreview={onWatch ? () => onWatch(track) : undefined}
        size="md"
        title={track.title}
      />
    </ObjectRow>
  );
}

// The two rare, destructive render controls behind a ⋮ (docs/admin-shell.md — one primary
// action per object; rare actions hidden by default). Requeue clears the video + re-renders;
// Purge evicts the cached edge renditions. Both route through the page's single confirm
// dialog, which carries the consequences.
function RenderActionsMenu({
  onPurge,
  onRequeue,
  title,
}: {
  onPurge: () => void;
  onRequeue: () => void;
  title: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${title}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <DotsThreeVerticalIcon aria-hidden="true" className="size-4" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onClick={onRequeue}>
          <ArrowsClockwiseIcon aria-hidden="true" className="size-4" />
          Requeue video
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onPurge}>
          <BroomIcon aria-hidden="true" className="size-4" />
          Purge renditions
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The two destructive controls, one controlled confirm. The consequences render as a
// deadpan two-item list — the machine facts, not prose.
const CONFIRM_COPY = {
  purge: {
    action: "Purge renditions",
    consequences: [
      "Evicts the cached edge renditions.",
      "The clip stays; the next view re-derives from the master.",
    ],
    pendingLabel: "Purging",
    title: "Purge renditions?",
  },
  requeue: {
    action: "Requeue video",
    consequences: [
      "Clears the video and takes it off radio.",
      "Re-renders on the box’s next tick.",
    ],
    pendingLabel: "Requeuing",
    title: "Requeue this video?",
  },
} as const;

function ConfirmDialog({
  onConfirm,
  onOpenChange,
  pending,
  target,
}: {
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  target: ConfirmTarget | undefined;
}) {
  const copy = target ? CONFIRM_COPY[target.kind] : undefined;

  return (
    <AlertDialog onOpenChange={onOpenChange} open={target !== undefined}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title ?? ""}</AlertDialogTitle>
          <AlertDialogDescription>
            {target ? `${target.track.artists.join(", ")} — ${target.track.title}` : ""}
            {target?.track.logId ? ` · ${target.track.logId}` : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          {(copy?.consequences ?? []).map((line) => (
            <li className="flex gap-2" key={line}>
              <span aria-hidden="true" className="select-none text-muted-foreground">
                ·
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm} variant="destructive">
            {pending ? (
              <CircleNotchIcon
                aria-hidden="true"
                className="motion-safe:animate-spin"
                weight="bold"
              />
            ) : undefined}
            {pending ? `${copy?.pendingLabel ?? "Working"}…` : (copy?.action ?? "Confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SectionHeading({ count, label }: { count: number; label: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <FilmReelIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold">{label}</h2>
      <span className="text-xs text-muted-foreground tabular-nums">({count})</span>
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <Empty className="border border-border p-6 text-sm text-muted-foreground">{children}</Empty>
  );
}

// POST the finding to the LIVE operator-tier oRPC op the CLI hits (bodyless — the
// trackId path param is the whole input; no content-type, mirroring adminApiPost).
// The browser admin grant cookie is the operator carrier, so it satisfies the tier.
async function postVideoAction(trackId: string, action: "purge" | "requeue"): Promise<void> {
  const response = await fetch(`/api/admin/tracks/${encodeURIComponent(trackId)}/video/${action}`, {
    credentials: "same-origin",
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
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

// "3h" / "12m" / "2d" elapsed since `fromIso` (whole units, terse per VOICE.md's
// tabular register), or "moments" under a minute.
function elapsedShort(fromIso: string, nowIso: string): string {
  const ms = new Date(nowIso).getTime() - new Date(fromIso).getTime();

  if (!Number.isFinite(ms) || ms < 60_000) {
    return "moments";
  }

  const minutes = Math.floor(ms / 60_000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// A transient notice that clears itself after 5s (the clip library's pattern).
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
