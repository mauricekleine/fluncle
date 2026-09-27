import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  DiscIcon,
  DotsThreeVerticalIcon,
  MusicNoteIcon,
  SealCheckIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { type LabelOutlierItem, type LabelOutlierRun } from "@fluncle/contracts";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import { Checkbox } from "@fluncle/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { ensureAdmin } from "@/lib/admin-guard";
import { formatDate } from "@/lib/format";
import { outlierArtists, outlierTitle, purgeHandoff } from "@/lib/label-outliers-handoff";
import { readError } from "@/lib/read-error";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listLabelOutliers } from "@/lib/server/label-outliers";

const OUTLIERS_KEY = ["admin", "label-outliers"] as const;

const TRACK_PREVIEW_LIMIT = 4;

type OutliersLens = "fine" | "review";

type OutliersBoard = { items: LabelOutlierItem[]; lastRun: LabelOutlierRun | null };

const fetchOutliers = createServerFn({ method: "GET" }).handler(
  async (): Promise<OutliersBoard> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listLabelOutliers();
  },
);

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/label-outliers")({
  validateSearch: (search: Record<string, unknown>): { lens: OutliersLens } => ({
    lens: search.lens === "fine" ? "fine" : "review",
  }),
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchOutliers(),
  component: AdminLabelOutliersPage,
});

async function putDismissed(unitIds: string[], dismissed: boolean): Promise<number> {
  const response = await fetch("/api/v1/admin/label-outliers/dismissed", {
    body: JSON.stringify({ dismissed, unitIds }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return ((await response.json()) as { changed: number }).changed;
}

async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast.error("Could not reach the clipboard.");
  }
}

function runSubtitle(lastRun: LabelOutlierRun | null, open: number): string {
  if (!lastRun) {
    return "No nightly run yet";
  }

  return `${open} to review · scored ${lastRun.tracksScored.toLocaleString("en-GB")} tracks on ${lastRun.labelsScored.toLocaleString("en-GB")} labels · ${formatDate(lastRun.ranAt)}`;
}

function AdminLabelOutliersPage() {
  const initial = Route.useLoaderData();
  const { lens } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchOutliers(),
    queryKey: OUTLIERS_KEY,
    refetchOnWindowFocus: true,
  });

  const open = useMemo(() => data.items.filter((item) => item.dismissedAt === null), [data]);
  const fine = useMemo(() => data.items.filter((item) => item.dismissedAt !== null), [data]);
  const visible = lens === "fine" ? fine : open;
  const selectedVisible = visible.filter((item) => selected.has(item.unitId));

  const setDismissed = useMutation({
    mutationFn: ({ dismissed, unitIds }: { dismissed: boolean; unitIds: string[] }) =>
      putDismissed(unitIds, dismissed),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save that ruling."),
    onSuccess: (_changed, { dismissed, unitIds }) => {
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: OUTLIERS_KEY });
      toast(dismissed ? `${unitIds.length} marked fine` : `${unitIds.length} back on the list`, {
        action: {
          label: "Undo",
          onClick: () => setDismissed.mutate({ dismissed: !dismissed, unitIds }),
        },
      });
    },
  });

  const toggle = (unitId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(unitId);
      } else {
        next.delete(unitId);
      }

      return next;
    });
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <AdminShell
      headerActions={
        lens === "review" && open.length > 0 ? (
          <Button
            onClick={() =>
              void copyText(purgeHandoff(open, today), "Copied for purge-albums.ts --albums-file")
            }
            size="sm"
            variant="outline"
          >
            <CopyIcon aria-hidden="true" />
            Copy for purge
          </Button>
        ) : undefined
      }
      subheader={
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 sm:px-5">
          <LensPill
            active={lens === "review"}
            count={open.length}
            label="To review"
            onClick={() => {
              setSelected(new Set());
              void navigate({ search: { lens: "review" } });
            }}
          />
          <LensPill
            active={lens === "fine"}
            count={fine.length}
            label="Looks fine"
            onClick={() => {
              setSelected(new Set());
              void navigate({ search: { lens: "fine" } });
            }}
          />
        </div>
      }
      subtitle={runSubtitle(data.lastRun, open.length)}
      title="Outliers"
    >
      <div className="space-y-4 p-4 sm:p-5">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Albums and singles that sound far from the rest of their own label, scored each night on
          the box. Open one and listen. If it belongs, mark it fine and it stays off this list until
          its tracks change. If it doesn't, copy it into the catalogue-prune skill: purge-albums.ts
          takes the album ids, and a single goes through its --tracks flag, purge-artists.ts, or an
          artist rule.
        </p>

        {selectedVisible.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <span className="text-sm tabular-nums">{selectedVisible.length} selected</span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                onClick={() =>
                  void copyText(
                    purgeHandoff(selectedVisible, today),
                    "Copied for purge-albums.ts --albums-file",
                  )
                }
                size="sm"
                variant="ghost"
              >
                <CopyIcon aria-hidden="true" />
                Copy for purge
              </Button>
              <Button
                disabled={setDismissed.isPending}
                onClick={() =>
                  setDismissed.mutate({
                    dismissed: lens === "review",
                    unitIds: selectedVisible.map((item) => item.unitId),
                  })
                }
                size="sm"
              >
                {lens === "review" ? "Looks fine" : "Back on the list"}
              </Button>
            </div>
          </div>
        ) : null}

        {visible.length === 0 ? (
          <EmptyOutliers hasRun={data.lastRun !== null} lens={lens} />
        ) : (
          <ObjectList>
            {visible.map((item) => (
              <OutlierRow
                busy={
                  setDismissed.isPending &&
                  (setDismissed.variables?.unitIds.includes(item.unitId) ?? false)
                }
                item={item}
                key={item.unitId}
                lens={lens}
                onRule={(dismissed) => setDismissed.mutate({ dismissed, unitIds: [item.unitId] })}
                onSelect={(checked) => toggle(item.unitId, checked)}
                selected={selected.has(item.unitId)}
              />
            ))}
          </ObjectList>
        )}
      </div>
    </AdminShell>
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

function EmptyOutliers({ hasRun, lens }: { hasRun: boolean; lens: OutliersLens }) {
  const [title, body] =
    lens === "fine"
      ? ["Nothing marked fine", "Anything you mark fine waits here until its tracks change."]
      : hasRun
        ? ["Nothing sounds out of place", "Every label's albums sit close to the rest of it."]
        : ["No nightly run yet", "The first run lands after the box's label-outliers timer fires."];

  return (
    <div className="mx-auto max-w-md rounded-lg border border-border bg-card/60 px-6 py-12 text-center">
      <SealCheckIcon
        aria-hidden="true"
        className="mx-auto mb-3 size-8 text-muted-foreground"
        weight="thin"
      />
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function OutlierRow({
  busy,
  item,
  lens,
  onRule,
  onSelect,
  selected,
}: {
  busy: boolean;
  item: LabelOutlierItem;
  lens: OutliersLens;
  onRule: (dismissed: boolean) => void;
  onSelect: (checked: boolean) => void;
  selected: boolean;
}) {
  const title = outlierTitle(item);
  const artists = outlierArtists(item);
  const single = item.album === null;
  const titleHref = item.album
    ? `/album/${item.album.slug}`
    : item.tracks[0]
      ? `/track/${item.tracks[0].trackId}`
      : undefined;
  const copyId = item.album?.id ?? item.tracks[0]?.trackId ?? item.unitId;
  const extraTracks = item.tracks.length - TRACK_PREVIEW_LIMIT;

  return (
    <ObjectRow
      trailing={
        <>
          <span className="text-xs text-muted-foreground tabular-nums">z {item.z.toFixed(1)}</span>
          {busy ? (
            <CircleNotchIcon
              aria-hidden="true"
              className="size-4 text-muted-foreground motion-safe:animate-spin"
              weight="bold"
            />
          ) : lens === "review" ? (
            <Button onClick={() => onRule(true)} size="sm">
              <CheckIcon aria-hidden="true" />
              Looks fine
            </Button>
          ) : (
            <Button onClick={() => onRule(false)} size="sm" variant="outline">
              <ArrowCounterClockwiseIcon aria-hidden="true" />
              Back on the list
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More for ${title}`}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <DotsThreeVerticalIcon aria-hidden="true" className="size-4" weight="bold" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  void copyText(copyId, single ? "Track id copied" : "Album id copied")
                }
              >
                <CopyIcon aria-hidden="true" />
                {single ? "Copy track id" : "Copy album id"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <Checkbox
        aria-label={`Select ${title}`}
        checked={selected}
        onCheckedChange={(checked) => onSelect(checked === true)}
      />
      <ObjectLead
        coordinate={item.label ? item.label.name : "No label"}
        coordinateHref={item.label ? `/label/${item.label.slug}` : undefined}
        leading={<ObjectGlyph icon={single ? MusicNoteIcon : DiscIcon} />}
        subtitle={
          <>
            {artists.length > 0 ? (
              <span className="flex flex-wrap gap-x-1.5">
                {artists.map((artist) => (
                  <a
                    className="hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
                    href={`/artist/${artist.slug}`}
                    key={artist.slug}
                  >
                    {artist.name}
                  </a>
                ))}
              </span>
            ) : (
              <span>No credited artist</span>
            )}
            <span>
              {item.score.toFixed(2)} against the{" "}
              {item.reference === "label" ? "label's" : "catalogue's"}{" "}
              {item.referenceMedian.toFixed(2)}
            </span>
            {item.discogsStyles.length > 0 ? <span>{item.discogsStyles.join(", ")}</span> : null}
            <span>since {formatDate(item.firstFlaggedAt)}</span>
            {single ? null : (
              <span className="flex w-full flex-wrap gap-x-2">
                {item.tracks.slice(0, TRACK_PREVIEW_LIMIT).map((track) => (
                  <a
                    className="hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
                    href={`/track/${track.trackId}`}
                    key={track.trackId}
                  >
                    {track.title}
                  </a>
                ))}
                {extraTracks > 0 ? <span>+{extraTracks} more</span> : null}
              </span>
            )}
          </>
        }
        title={title}
        titleHref={titleHref}
      />
    </ObjectRow>
  );
}
