import {
  ArrowsClockwiseIcon,
  ArrowUUpLeftIcon,
  CircleNotchIcon,
  BinocularsIcon,
  PauseIcon,
  PlayIcon,
  ThumbsDownIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  type CaptureBudgetState,
  type CapturePriorityReason,
  type CatalogueLens,
  type CatalogueMatch,
} from "@fluncle/contracts";
import { CAPTURE_TIER_LABELS } from "@/lib/capture-tier";
import { readError } from "@/lib/read-error";
import { ensureAdmin } from "@/lib/admin-guard";
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
} from "@fluncle/ui/components/alert-dialog";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { AppleMusicIcon, SpotifyIcon } from "@/components/platform-icons";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@fluncle/ui/components/empty";
import { Label } from "@fluncle/ui/components/label";
import { Progress } from "@fluncle/ui/components/progress";
import { Switch } from "@fluncle/ui/components/switch";
import { usePreviewControls } from "@/lib/preview-player";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { getCatalogueCaptureState } from "@/lib/server/capture-budget";
import {
  type CatalogueSummary,
  type CatalogueTrackItem,
  getCatalogueSummary,
  listCatalogueTracks,
} from "@/lib/server/catalogue";
import { albumCoverAtSize } from "@/lib/media";

const CATALOGUE_KEY = ["admin", "catalogue"] as const;

type CataloguePayload = {
  budget: CaptureBudgetState;
  summary: CatalogueSummary;
  tracks: CatalogueTrackItem[];
};

type CatalogueSearch = { lens: CatalogueLens };

const fetchCatalogue = createServerFn({ method: "GET" })
  .inputValidator((lens: CatalogueLens) => lens)
  .handler(async ({ data: lens }): Promise<CataloguePayload> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const [tracks, summary, budget] = await Promise.all([
      listCatalogueTracks(lens, 50),
      getCatalogueSummary(),

      getCatalogueCaptureState(),
    ]);

    return { budget, summary, tracks };
  });

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/catalogue")({
  validateSearch: (search: Record<string, unknown>): CatalogueSearch => ({
    lens:
      search.lens === "capture"
        ? "capture"
        : search.lens === "long"
          ? "long"
          : search.lens === "quarantine"
            ? "quarantine"
            : search.lens === "dismissed"
              ? "dismissed"
              : "ear",
  }),
  loaderDeps: ({ search }) => ({ lens: search.lens }),
  beforeLoad: () => ensureAdmin(),
  loader: ({ deps }) => fetchCatalogue({ data: deps.lens }),
  component: AdminCataloguePage,
});

function AdminCataloguePage() {
  const initial = Route.useLoaderData();
  const { lens } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();

  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchCatalogue({ data: lens }),
    queryKey: [...CATALOGUE_KEY, lens],
    refetchOnWindowFocus: true,

    staleTime: 20_000,
  });

  const rank = useMutation({
    mutationFn: () => postRank(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY }),
  });

  const setPaused = useMutation({
    mutationFn: (paused: boolean) => putCaptureBudget({ paused }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY }),
  });

  const clearAudio = useMutation({
    mutationFn: (trackId: string) => postClearWrongAudio(trackId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY }),
  });

  const blameFinding = useMutation({
    mutationFn: async ({
      findingTrackId,
      trackId,
    }: {
      findingTrackId: string;
      trackId: string;
    }) => {
      await postFlagWrongAudio(findingTrackId);
      await postClearWrongAudio(trackId);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not flag the finding."),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY });
      toast.success("The finding is re-capturing", {
        description: "This row kept its audio and rejoins the ranking.",
      });
    },
  });

  const forceCapture = useMutation({
    mutationFn: (trackId: string) => postForceCapture(trackId),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not force the capture."),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY });
      toast.success("Capturing anyway", {
        description: "The duplicate veto is lifted; it rejoins the capture queue.",
      });
    },
  });

  const restore = useMutation({
    mutationFn: (trackId: string) => putDismissed(trackId, false),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY }),
  });

  const dismiss = useMutation({
    mutationFn: (trackId: string) => putDismissed(trackId, true),
    onSuccess: (_result, trackId) => {
      void queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY });
      toast("Not for me", {
        action: { label: "Undo", onClick: () => restore.mutate(trackId) },
      });
    },
  });

  const [confirmTrack, setConfirmTrack] = useState<CatalogueTrackItem | null>(null);
  const certify = useMutation({
    mutationFn: (trackId: string) => postCertify(trackId),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not log it."),
    onSettled: () => setConfirmTrack(null),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY });
      toast.success(`Logged — ${result.logId}`, { description: "Enrichment is running." });

      void navigate({ search: { mix: "all", stage: "all" }, to: "/admin/findings" });
    },
  });

  const { budget, summary, tracks } = data;

  return (
    <AdminShell
      headerActions={
        <Button disabled={rank.isPending} onClick={() => rank.mutate()} size="sm" variant="outline">
          {rank.isPending ? (
            <CircleNotchIcon
              aria-hidden="true"
              className="motion-safe:animate-spin"
              weight="bold"
            />
          ) : (
            <ArrowsClockwiseIcon aria-hidden="true" weight="bold" />
          )}
          Re-rank
        </Button>
      }
      subheader={
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 sm:px-5">
          <LensPill
            active={lens === "ear"}
            count={summary.ranked}
            label="Closest to a finding"
            onClick={() => void navigate({ search: { lens: "ear" } })}
          />
          <LensPill
            active={lens === "capture"}
            count={summary.awaitingCapture}
            label="Next to capture"
            onClick={() => void navigate({ search: { lens: "capture" } })}
          />
          <Button
            onClick={() => void navigate({ search: { lens: "long" } })}
            size="sm"
            variant={lens === "long" ? "secondary" : "ghost"}
          >
            Long mixes
          </Button>

          {summary.quarantined > 0 || lens === "quarantine" ? (
            <LensPill
              active={lens === "quarantine"}
              count={summary.quarantined}
              label="Wrong audio"
              onClick={() => void navigate({ search: { lens: "quarantine" } })}
            />
          ) : null}

          {summary.dismissed > 0 || lens === "dismissed" ? (
            <LensPill
              active={lens === "dismissed"}
              count={summary.dismissed}
              label="Dismissed"
              onClick={() => void navigate({ search: { lens: "dismissed" } })}
            />
          ) : null}
          {rank.isError ? (
            <span className="ml-2 text-xs text-destructive" role="alert">
              {rank.error instanceof Error ? rank.error.message : "The re-rank failed."}
            </span>
          ) : null}
        </div>
      }
      subtitle={summaryLine(summary)}
      title="The Ear"
    >
      <div className="space-y-4 p-4 sm:p-5">
        {lens === "capture" ? (
          <CaptureBudgetCard
            budget={budget}
            onToggle={(paused) => setPaused.mutate(paused)}
            pending={setPaused.isPending}
          />
        ) : null}

        {tracks.length === 0 ? (
          <EmptyCatalogue lens={lens} summary={summary} />
        ) : (
          <ObjectList>
            {tracks.map((track) => (
              <CatalogueRow
                busy={{
                  blaming:
                    blameFinding.isPending && blameFinding.variables?.trackId === track.trackId,
                  certifying: certify.isPending && certify.variables === track.trackId,
                  clearing: clearAudio.isPending && clearAudio.variables === track.trackId,
                  dismissing: dismiss.isPending && dismiss.variables === track.trackId,
                  forcing: forceCapture.isPending && forceCapture.variables === track.trackId,
                  restoring: restore.isPending && restore.variables === track.trackId,
                }}
                key={track.trackId}
                lens={lens}
                onBlameFinding={(findingTrackId) =>
                  blameFinding.mutate({ findingTrackId, trackId: track.trackId })
                }
                onCertify={() => setConfirmTrack(track)}
                onClear={() => clearAudio.mutate(track.trackId)}
                onDismiss={() => dismiss.mutate(track.trackId)}
                onForceCapture={() => forceCapture.mutate(track.trackId)}
                onRestore={() => restore.mutate(track.trackId)}
                track={track}
              />
            ))}
          </ObjectList>
        )}
      </div>

      <LogItConfirm
        busy={certify.isPending}
        onConfirm={() => {
          if (confirmTrack) {
            certify.mutate(confirmTrack.trackId);
          }
        }}
        onOpenChange={(open) => {
          if (!open && !certify.isPending) {
            setConfirmTrack(null);
          }
        }}
        track={confirmTrack}
      />
    </AdminShell>
  );
}

function LogItConfirm({
  busy,
  onConfirm,
  onOpenChange,
  track,
}: {
  busy: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  track: CatalogueTrackItem | null;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={track !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Log it as a finding?</AlertDialogTitle>
          <AlertDialogDescription>
            {track ? `${track.artists.join(", ")} — ${track.title}` : ""} gets its Log ID and enters
            the archive. Enrichment starts on its own; you land on the finding to finish the note
            and galaxy.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Not yet</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={onConfirm}>
            {busy ? (
              <CircleNotchIcon
                aria-hidden="true"
                className="motion-safe:animate-spin"
                weight="bold"
              />
            ) : null}
            Log it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function countsAgo(iso: string | null): string | null {
  if (!iso) {
    return null;
  }

  const then = Date.parse(iso);

  if (Number.isNaN(then)) {
    return null;
  }

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));

  if (seconds < 45) {
    return "just now";
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours} h ago`;
  }

  return `${Math.round(hours / 24)} d ago`;
}

function summaryLine(summary: CatalogueSummary): string {
  if (summary.total === 0) {
    return "Nothing out there yet";
  }

  const parts = [`${summary.total} not logged`];

  if (summary.ranked > 0) {
    parts.push(`${summary.ranked} ranked`);
  }

  if (summary.awaitingCapture > 0) {
    parts.push(`${summary.awaitingCapture} waiting on audio`);
  }

  if (summary.awaitingRank > 0) {
    parts.push(`${summary.awaitingRank} unranked`);
  }

  const ago = countsAgo(summary.computedAt);

  if (ago) {
    parts.push(`counts ${ago}`);
  }

  return parts.join(" · ");
}

function EmptyCatalogue({ lens, summary }: { lens: CatalogueLens; summary: CatalogueSummary }) {
  if (lens === "long") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BinocularsIcon aria-hidden="true" weight="thin" />
          </EmptyMedia>
          <EmptyTitle>No long mixes</EmptyTitle>
          <EmptyDescription>No active catalogue rows meet the long-form boundary.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (lens === "quarantine") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BinocularsIcon aria-hidden="true" weight="thin" />
          </EmptyMedia>
          <EmptyTitle>No wrong-audio captures</EmptyTitle>
          <EmptyDescription>
            Every capture matched the track it was for. When one comes back as the artist&apos;s
            other, already-logged tune instead, it lands here to be re-captured.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (lens === "dismissed") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BinocularsIcon aria-hidden="true" weight="thin" />
          </EmptyMedia>
          <EmptyTitle>Nothing set aside</EmptyTitle>
          <EmptyDescription>
            You have not waved anything off. When you mark a track &ldquo;not for me&rdquo; it drops
            out of the ranking and lands here, restorable any time.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const nothingAtAll = summary.total === 0;
  const title = nothingAtAll
    ? "Nothing out there yet"
    : lens === "ear"
      ? "Nothing to listen to yet"
      : "Everything in has been heard";
  const description = nothingAtAll
    ? "No track the archive knows is uncertified — there is nothing out there to point at. When tracks start arriving, the ones sitting closest to a finding surface here first."
    : lens === "ear"
      ? `${summary.total} tracks are in, and not one has been heard yet. A track has no vector until its audio is captured, so until then there is nothing to rank. They are queued under "Next to capture".`
      : "Every uncertified track in the archive already has its audio. Nothing is waiting to be captured.";

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BinocularsIcon aria-hidden="true" weight="thin" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {summary.awaitingRank > 0 ? (
        <EmptyContent>
          <p className="text-xs text-muted-foreground">
            {summary.awaitingRank} {summary.awaitingRank === 1 ? "track has" : "tracks have"} never
            been ranked. Re-rank to work through them.
          </p>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

function LensPill({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick} size="sm" variant={active ? "secondary" : "ghost"}>
      {label}
      <Badge className="ml-1 tabular-nums" variant={active ? "outline" : "secondary"}>
        {count}
      </Badge>
    </Button>
  );
}

type CatalogueRowBusy = {
  blaming: boolean;
  certifying: boolean;
  clearing: boolean;
  dismissing: boolean;
  forcing: boolean;
  restoring: boolean;
};

function CatalogueRow({
  busy,
  lens,
  onBlameFinding,
  onCertify,
  onClear,
  onDismiss,
  onForceCapture,
  onRestore,
  track,
}: {
  busy: CatalogueRowBusy;
  lens: CatalogueLens;
  onBlameFinding: (findingTrackId: string) => void;
  onCertify: () => void;
  onClear: () => void;
  onDismiss: () => void;
  onForceCapture: () => void;
  onRestore: () => void;
  track: CatalogueTrackItem;
}) {
  return (
    <ObjectRow
      trailing={
        <>
          {track.hiddenFromPublic ? (
            <Badge className="whitespace-nowrap" variant="outline">
              Hidden · long mix
            </Badge>
          ) : null}
          {lens === "quarantine" ? (
            <Badge className="whitespace-nowrap" variant="outline">
              Wrong audio
            </Badge>
          ) : track.duplicateOf ? (
            <Badge className="whitespace-nowrap" variant="outline">
              Already logged
            </Badge>
          ) : lens === "capture" ? (
            <Badge className="whitespace-nowrap" variant="secondary">
              {captureTierLabel(track.captureReason)}
            </Badge>
          ) : null}

          {lens === "ear" || lens === "capture" ? (
            <span className="flex w-14 shrink-0 items-center justify-end gap-0.5">
              {track.spotifyUrl ? (
                <ListenLink href={track.spotifyUrl} label={`Open ${track.title} in Spotify`}>
                  <SpotifyIcon className="size-4" />
                </ListenLink>
              ) : null}
              {track.appleMusicUrl ? (
                <ListenLink href={track.appleMusicUrl} label={`Open ${track.title} in Apple Music`}>
                  <AppleMusicIcon className="size-4" />
                </ListenLink>
              ) : null}
            </span>
          ) : null}

          {lens === "ear" ? (
            <span
              aria-label={`Similarity to its nearest finding: ${formatScore(track.nearestFindingScore)}`}
              className="w-11 shrink-0 text-right text-sm font-medium tabular-nums"
            >
              {formatScore(track.nearestFindingScore)}
            </span>
          ) : null}

          {lens === "quarantine" ? (
            <>
              <Button
                aria-label={`Not for me: ${track.title} (also cancels its re-capture)`}
                disabled={busy.dismissing}
                onClick={onDismiss}
                size="icon-sm"
                title="Not for me — also cancels the queued re-capture"
                variant="ghost"
              >
                {busy.dismissing ? (
                  <CircleNotchIcon
                    aria-hidden="true"
                    className="motion-safe:animate-spin"
                    weight="bold"
                  />
                ) : (
                  <ThumbsDownIcon aria-hidden="true" />
                )}
              </Button>
              <PendingButton onClick={onClear} pending={busy.clearing} variant="outline">
                Keep it
              </PendingButton>
              {track.nearestFinding ? (
                <PendingButton
                  onClick={() => {
                    const finding = track.nearestFinding;
                    if (finding) {
                      onBlameFinding(finding.trackId);
                    }
                  }}
                  pending={busy.blaming}
                  variant="outline"
                >
                  Re-capture the finding
                </PendingButton>
              ) : null}
            </>
          ) : null}

          {lens === "dismissed" ? (
            <PendingButton onClick={onRestore} pending={busy.restoring} variant="outline">
              <ArrowUUpLeftIcon aria-hidden="true" weight="bold" />
              Restore
            </PendingButton>
          ) : null}

          {lens === "capture" && track.duplicateOf ? (
            <PendingButton onClick={onForceCapture} pending={busy.forcing} variant="outline">
              Capture anyway
            </PendingButton>
          ) : null}

          {lens === "ear" || lens === "capture" ? (
            <>
              <Button
                aria-label={`Not for me: ${track.title}`}
                disabled={busy.dismissing}
                onClick={onDismiss}
                size="icon-sm"
                title="Not for me"
                variant="ghost"
              >
                {busy.dismissing ? (
                  <CircleNotchIcon
                    aria-hidden="true"
                    className="motion-safe:animate-spin"
                    weight="bold"
                  />
                ) : (
                  <ThumbsDownIcon aria-hidden="true" />
                )}
              </Button>

              <PendingButton onClick={onCertify} pending={busy.certifying} variant="outline">
                Log it
              </PendingButton>
            </>
          ) : null}
        </>
      }
    >
      <ObjectLead
        leading={
          <CatalogueCover
            auditionSrc={
              lens === "quarantine" || (!track.hasPreview && track.hasCapturedAudio)
                ? `/api/v1/admin/tracks/${encodeURIComponent(track.trackId)}/source-audio`
                : undefined
            }
            cover={track.albumImageUrl}
            title={track.title}
            trackId={track.trackId}
            playable={lens === "quarantine" || track.hasPreview || track.hasCapturedAudio}
          />
        }
        subtitle={
          <>
            <span className="truncate">{track.artists.join(", ")}</span>
            {track.label ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{track.label}</span>
              </>
            ) : null}
            {track.bpm ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{Math.round(track.bpm)} BPM</span>
              </>
            ) : null}
            {track.releaseDate ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{track.releaseDate.slice(0, 4)}</span>
              </>
            ) : null}

            <span className="basis-full truncate text-foreground/80">
              <Why lens={lens} track={track} />
            </span>
          </>
        }
        title={track.title}
      />
    </ObjectRow>
  );
}

function Why({ lens, track }: { lens: CatalogueLens; track: CatalogueTrackItem }): ReactNode {
  if (lens === "quarantine") {
    if (track.captureVerification === "mismatch" && !track.nearestFinding) {
      return "Its audio doesn't match the official preview — a fresh download is queued.";
    }

    return track.nearestFinding ? (
      <>
        <MatchLine lead="Its audio came back as" match={track.nearestFinding} />
        {" — a fresh download is queued."}
      </>
    ) : (
      "Its audio matched a track already in the archive — a fresh download is queued."
    );
  }

  if (track.duplicateOf) {
    return <MatchLine lead="Already in the archive —" match={track.duplicateOf} />;
  }

  if (lens === "capture") {
    return captureWhy(track.captureReason);
  }

  const match = track.nearestFinding;

  if (!match) {
    return "Nothing to compare it to yet.";
  }

  return <MatchLine lead="Closest to" match={match} />;
}

function MatchLine({ lead, match }: { lead: string; match: CatalogueMatch }): ReactNode {
  return (
    <>
      {lead}{" "}
      {match.logId ? (
        <span className="font-mono text-[11px] tracking-tight tabular-nums">{match.logId}</span>
      ) : null}{" "}
      {match.artists.join(", ")} — {match.title}
    </>
  );
}

function captureWhy(reason: CapturePriorityReason | null): string {
  switch (reason?.kind) {
    case "artist": {
      return `${reason.name} is already in the archive.`;
    }
    case "label": {
      return `${reason.name} already carries a finding.`;
    }
    case "seed-label": {
      return `${reason.name} is a label the crawler digs from.`;
    }
    case "skipped-label": {
      return `${reason.name} is not your lane. Ranked last, kept anyway.`;
    }
    case "unauthorized": {
      return "No artist here has earned the spend yet. Held back, kept anyway.";
    }
    default: {
      return "Nothing ties it to the archive yet.";
    }
  }
}

function captureTierLabel(reason: CapturePriorityReason | null): string {
  return CAPTURE_TIER_LABELS[reason?.kind ?? "none"];
}

function formatScore(score: number | null): string {
  return typeof score === "number" ? score.toFixed(2) : "—";
}

function ListenLink({
  children,
  href,
  label,
}: {
  children: ReactNode;
  href: string;
  label: string;
}) {
  return (
    <Button
      nativeButton={false}
      render={<a aria-label={label} href={href} rel="noreferrer" target="_blank" title={label} />}
      size="icon-sm"
      variant="ghost"
    >
      {children}
    </Button>
  );
}

function PendingButton({
  children,
  onClick,
  pending,
  variant,
}: {
  children: ReactNode;
  onClick: () => void;
  pending: boolean;
  variant: "default" | "ghost" | "outline";
}) {
  return (
    <Button disabled={pending} onClick={onClick} size="sm" variant={variant}>
      {pending ? (
        <CircleNotchIcon aria-hidden="true" className="motion-safe:animate-spin" weight="bold" />
      ) : null}
      {children}
    </Button>
  );
}

function CatalogueCover({
  auditionSrc,
  cover,
  playable,
  title,
  trackId,
}: {
  auditionSrc?: string;
  cover: string | null;
  playable: boolean;
  title: string;
  trackId: string;
}) {
  const { activeTrackId, pauseResume, start, status } = usePreviewControls();
  const [coverFailed, setCoverFailed] = useState(false);
  const isCurrent = activeTrackId === trackId;
  const isPlaying = isCurrent && (status === "playing" || status === "loading");

  const art =
    cover && !coverFailed ? (
      <img
        alt=""
        className="size-11 shrink-0 rounded-md border border-border object-cover"
        onError={() => setCoverFailed(true)}
        src={albumCoverAtSize(cover, "small")}
      />
    ) : (
      <ObjectGlyph icon={WaveformIcon} />
    );

  if (!playable) {
    return art;
  }

  return (
    <span className="relative shrink-0">
      {art}
      <button
        aria-label={
          isPlaying
            ? `Pause ${title}`
            : auditionSrc
              ? `Play the captured audio of ${title}`
              : `Play the preview of ${title}`
        }
        aria-pressed={isCurrent}
        className="absolute inset-0 flex items-center justify-center rounded-md bg-background/55 text-foreground opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring aria-pressed:opacity-100"
        onClick={() => (isCurrent ? pauseResume() : start(trackId, { src: auditionSrc }))}
        title={auditionSrc ? "Plays the captured file itself, not the store preview" : undefined}
        type="button"
      >
        {isPlaying ? (
          <PauseIcon aria-hidden="true" className="size-4" weight="fill" />
        ) : (
          <PlayIcon aria-hidden="true" className="size-4" weight="fill" />
        )}
      </button>
    </span>
  );
}

const GB = 1024 * 1024 * 1024;

function formatGb(bytes: number): string {
  return `${(bytes / GB).toFixed(2)} GB`;
}

function usedPercent(spent: number, cap: number): number {
  if (cap <= 0) {
    return 100;
  }

  return Math.min(100, Math.round((spent / cap) * 100));
}

function CaptureBudgetCard({
  budget,
  onToggle,
  pending,
}: {
  budget: CaptureBudgetState;
  onToggle: (paused: boolean) => void;
  pending: boolean;
}) {
  const stopped = !budget.open;
  const capReached =
    budget.closedReason === "bytes_spent" || budget.closedReason === "tracks_spent";

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Switch
          aria-label="Let the catalogue spend on audio capture"
          checked={!budget.paused}
          disabled={pending}
          id="catalogue-capture-switch"
          onCheckedChange={(next) => onToggle(!next)}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor="catalogue-capture-switch">Buy audio for the catalogue</Label>
          <p className="text-sm text-muted-foreground">
            {budget.paused
              ? "Stopped. Nothing down here is costing you anything. Your findings still capture as normal."
              : capReached
                ? "Running, but the last 24h is spent. It picks up again as the window rolls."
                : "Running. It buys the top of the queue below, up to the budget, and stops."}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Meter
          detail={`of ${budget.budget.dailyTracks}`}
          label={`Bought (${budget.windowHours}h)`}
          percent={usedPercent(budget.spend.tracks, budget.budget.dailyTracks)}
          value={`${budget.spend.tracks} ${budget.spend.tracks === 1 ? "track" : "tracks"}`}
        />
        <Meter
          detail={`of ${formatGb(budget.budget.dailyBytes)}`}
          label="Downloaded"
          percent={usedPercent(budget.spend.bytes, budget.budget.dailyBytes)}
          value={formatGb(budget.spend.bytes)}
        />
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-xs text-muted-foreground">Left in the window</dt>
          <dd className="mt-1 text-sm font-medium tabular-nums">
            {stopped ? (
              <span className="text-muted-foreground">
                {budget.paused ? "Stopped by you" : "Spent"}
              </span>
            ) : (
              <>
                {budget.remainingTracks} {budget.remainingTracks === 1 ? "track" : "tracks"} ·{" "}
                {formatGb(budget.remainingBytes)}
              </>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Meter({
  detail,
  label,
  percent,
  value,
}: {
  detail: string;
  label: string;
  percent: number;
  value: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 space-y-1.5">
        <span className="block text-sm font-medium tabular-nums">
          {value} <span className="font-normal text-muted-foreground">{detail}</span>
        </span>
        <Progress aria-label={`${label}: ${value} ${detail}`} value={percent} />
      </dd>
    </div>
  );
}

async function postRank(): Promise<void> {
  const response = await fetch("/api/v1/admin/catalogue/rank", {
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function postClearWrongAudio(trackId: string): Promise<void> {
  const response = await fetch("/api/v1/admin/catalogue/wrong-audio/clear", {
    body: JSON.stringify({ trackId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function postFlagWrongAudio(trackId: string): Promise<void> {
  const response = await fetch("/api/v1/admin/catalogue/wrong-audio/flag", {
    body: JSON.stringify({ trackId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function postForceCapture(trackId: string): Promise<void> {
  const response = await fetch("/api/v1/admin/catalogue/force-capture", {
    body: JSON.stringify({ trackId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function postCertify(trackId: string): Promise<{ logId: string }> {
  const response = await fetch("/api/v1/admin/catalogue/certify", {
    body: JSON.stringify({ trackId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as { logId: string };
}

async function putDismissed(trackId: string, dismissed: boolean): Promise<void> {
  const response = await fetch("/api/v1/admin/catalogue/dismissed", {
    body: JSON.stringify({ dismissed, trackId }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function putCaptureBudget(input: {
  dailyBytes?: number;
  dailyTracks?: number;
  paused?: boolean;
}): Promise<void> {
  const response = await fetch("/api/v1/admin/catalogue/capture-budget", {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
