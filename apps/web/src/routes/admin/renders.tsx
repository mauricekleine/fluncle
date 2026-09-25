import {
  ArrowsClockwiseIcon,
  BroomIcon,
  CircleNotchIcon,
  DotsThreeVerticalIcon,
  FilmReelIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";
import { elapsedShort } from "@/lib/format";
import { readError } from "@/lib/read-error";
import { ensureAdmin } from "@/lib/admin-guard";
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
import { useAutoNotice } from "@/lib/use-auto-notice";
import {
  type BoardTrackListItem,
  listRecentlyRenderedFindings,
  listTracks,
} from "@/lib/server/tracks";

const QUEUE_LIMIT = 60;
const SHIPPED_LIMIT = 24;

const RENDERS_KEY = ["admin", "renders"] as const;

const RENDERS_STALE_MS = 20_000;

const NAV_COUNTS_KEY = ["admin", "nav", "counts"] as const;

type BoxService = {
  checkedAt: string;
  message: string | null;
  since: string;
  status: ServiceHealthStatus;
} | null;

type RendersData = {
  box: { conductor: BoxService; renderBox: BoxService };

  now: string;
  queue: BoardTrackListItem[];

  queueMore: boolean;
  shipped: BoardTrackListItem[];
};

const fetchRenders = createServerFn({ method: "GET" }).handler(async (): Promise<RendersData> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  const [queuePage, shipped, services] = await Promise.all([
    listTracks({
      board: true,
      countTotal: false,
      hasContext: true,
      hasVideo: false,
      limit: QUEUE_LIMIT,
      order: "asc",
    }),
    listRecentlyRenderedFindings(SHIPPED_LIMIT),
    getServiceStatuses(),
  ]);

  const pick = (service: string): BoxService => {
    const row = services.find((entry) => entry.service === service);

    return row?.checked_at && row.since
      ? { checkedAt: row.checked_at, message: row.message, since: row.since, status: row.status }
      : null;
  };

  return {
    box: { conductor: pick("cron.render"), renderBox: pick("render-box") },
    now: new Date().toISOString(),
    queue: queuePage.tracks,
    queueMore: Boolean(queuePage.nextCursor),
    shipped,
  };
});

export const Route = createFileRoute("/admin/renders")({
  beforeLoad: () => ensureAdmin(),
  component: RendersPage,
  loader: async () => ({ renders: await fetchRenders() }),
});

type ConfirmTarget = { kind: "purge" | "requeue"; track: BoardTrackListItem };

function RendersPage() {
  const { renders: initial } = Route.useLoaderData();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchRenders(),
    queryKey: RENDERS_KEY,
    refetchOnWindowFocus: true,
    staleTime: RENDERS_STALE_MS,
  });

  const [watch, setWatch] = useState<BoardTrackListItem | undefined>();
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
    mutationFn: (track: BoardTrackListItem) => postVideoAction(track.trackId, "requeue"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSettled: () => setConfirm(undefined),
    onSuccess: async () => {
      setNotice("Requeued. Back in the render queue.");
      await refresh();
    },
  });

  const purge = useMutation({
    mutationFn: (track: BoardTrackListItem) => postVideoAction(track.trackId, "purge"),
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

  const subtitle = `${data.queue.length}${data.queueMore ? "+" : ""} awaiting · ${data.shipped.length} recent`;

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

        <QueueSection more={data.queueMore} now={data.now} queue={data.queue} />

        <ShippedSection
          now={data.now}
          onPurge={(track) => setConfirm({ kind: "purge", track })}
          onRequeue={(track) => setConfirm({ kind: "requeue", track })}
          onWatch={setWatch}
          shipped={data.shipped}
        />
      </div>

      <ConfirmDialog
        onConfirm={onConfirm}
        onOpenChange={(open) => !open && !pending && setConfirm(undefined)}
        pending={pending}
        target={confirm}
      />

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
      <Badge className="shrink-0 border-transparent bg-[var(--eclipse-glow)]/15 text-[var(--eclipse-glow)]">
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

function QueueSection({
  more,
  now,
  queue,
}: {
  more: boolean;
  now: string;
  queue: BoardTrackListItem[];
}) {
  return (
    <section aria-label="Render queue">
      <SectionHeading count={queue.length} label="Awaiting a video" more={more} />
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

function ShippedSection({
  now,
  onPurge,
  onRequeue,
  onWatch,
  shipped,
}: {
  now: string;
  onPurge: (track: BoardTrackListItem) => void;
  onRequeue: (track: BoardTrackListItem) => void;
  onWatch: (track: BoardTrackListItem) => void;
  shipped: BoardTrackListItem[];
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

function Ledger({ track }: { track: BoardTrackListItem }) {
  const parts = [track.videoVehicle, track.videoGrain, track.videoRegister].filter(
    (part): part is string => Boolean(part?.trim()),
  );

  if (parts.length === 0) {
    return null;
  }

  return <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>;
}

function RenderRow({
  onWatch,
  track,
  trailing,
}: {
  onWatch?: (track: BoardTrackListItem) => void;
  track: BoardTrackListItem;
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

function SectionHeading({
  count,
  label,
  more = false,
}: {
  count: number;
  label: string;

  more?: boolean;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <FilmReelIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold">{label}</h2>
      <span className="text-xs text-muted-foreground tabular-nums">
        ({count}
        {more ? "+" : ""})
      </span>
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <Empty className="border border-border p-6 text-sm text-muted-foreground">{children}</Empty>
  );
}

async function postVideoAction(trackId: string, action: "purge" | "requeue"): Promise<void> {
  const response = await fetch(
    `/api/v1/admin/tracks/${encodeURIComponent(trackId)}/video/${action}`,
    {
      credentials: "same-origin",
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
