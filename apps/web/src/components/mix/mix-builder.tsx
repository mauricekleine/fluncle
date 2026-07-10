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
import { DotsSixVerticalIcon, PauseIcon, PlayIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useMemo, useState } from "react";
import { type FeedItem, type MixableCandidate, type TrackListItem } from "@fluncle/contracts";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@fluncle/ui/components/command";
import { MixPreviewBar } from "@/components/mix/mix-preview-bar";
import { TrackArtwork } from "@/components/track-artwork";
import { TrackChips } from "@/components/track-row";
import { formatKey, type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { mixReasonLabel } from "@/lib/mix-set";
import { usePreviewControls } from "@/lib/preview-player";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/** The finding's stable identity for keys and drag-and-drop: its coordinate, or the trackId. */
const rowId = (finding: TrackListItem): string => finding.logId ?? finding.trackId;

// Product A's plate (RFC mixability-engine §3): one printed logbook page — the crew
// taking the decks with Fluncle's findings. NOT a SaaS builder. The design invariants
// (§3.0) are gates: exactly ONE gold primary (Copy set link); no numeric score ever
// reaches the crew (only the reason chip); a builder-row variant (not TrackRow's
// stretched link); reorder via keyboard up/down (no drag dependency). Copy PENDING the
// morning review (Decision 5).

const artworkUrl = (finding: TrackListItem): string | undefined =>
  spotifyAlbumImageAtSize(finding.albumImageUrl, "small");

// The album artwork doubles as the row's preview control (§3.3.4): a play/pause
// overlay that previews THIS finding via the shared `/api/preview/<logId>` relay —
// on chain rows AND candidate rows alike. One shared <audio>, so starting a row's
// preview stops the previous one; the overlay is hover/focus-visible on pointers and
// always visible on touch (`.preview-art-btn` CSS). Reduced motion drops its fade.
function PreviewArtwork({ finding, logId }: { finding: TrackListItem; logId: string }) {
  const { activeTrackId, pauseResume, start, status } = usePreviewControls();
  const isCurrent = activeTrackId === logId;
  const isPlaying = isCurrent && (status === "playing" || status === "loading");

  const onClick = useCallback(() => {
    if (isCurrent) {
      pauseResume();
    } else {
      start(logId);
    }
  }, [isCurrent, logId, pauseResume, start]);

  return (
    <span className="preview-art relative shrink-0">
      <TrackArtwork alt="" src={artworkUrl(finding)} />
      <button
        aria-label={isPlaying ? "Pause" : `Play the preview of ${finding.title}`}
        aria-pressed={isCurrent}
        className="preview-art-btn"
        onClick={onClick}
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

// A builder row — the TrackRow grid skeleton (coordinate, 3.25rem artwork, title, a
// chip row) WITHOUT the stretched navigation link, so Add / remove / reorder can each
// own their own hit target (§3.0 invariant 3). `leading` mounts a drag handle ahead of
// the artwork; `rowRef`/`style`/`dragging` let a sortable wrapper drive the <li>.
function BuilderRow({
  actions,
  chip,
  dragging = false,
  finding,
  leading,
  notation,
  rowRef,
  style,
}: {
  actions?: React.ReactNode;
  chip?: React.ReactNode;
  dragging?: boolean;
  finding: TrackListItem;
  leading?: React.ReactNode;
  notation: KeyNotation;
  rowRef?: (element: HTMLLIElement | null) => void;
  style?: CSSProperties;
}) {
  // The telemetry line — duration, BPM, key as the homepage Track Row's quiet bordered
  // chips (reused verbatim, one chip definition across the app), with the reason chip
  // after it. Nothing renders until enrichment has produced a value.
  const hasTelemetry = Boolean(finding.durationMs || finding.bpm || finding.key);

  return (
    <li
      className={cn("flex items-center gap-3 px-3 py-2.5", dragging && "relative z-10 bg-muted")}
      ref={rowRef}
      style={style}
    >
      {leading}
      <div className="min-w-0 flex flex-1 items-center gap-3">
        {finding.logId ? (
          <PreviewArtwork finding={finding} logId={finding.logId} />
        ) : (
          <TrackArtwork alt="" src={artworkUrl(finding)} />
        )}
        <div className="min-w-0 flex-1">
          {finding.logId ? (
            // The coordinate in the canon numeric face — Oxanium tabular at the Track
            // Row's size (The Tabular Rule; mono is reserved for machine surfaces).
            <Link
              className="track-log-id track-log-id-link block truncate"
              params={{ logId: finding.logId }}
              to="/log/$logId"
            >
              {finding.logId}
            </Link>
          ) : null}
          <p className="truncate text-sm font-medium">{finding.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {finding.artists.join(", ")}
          </p>
          {hasTelemetry || chip ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <TrackChips
                bpm={finding.bpm}
                className="m-0"
                durationMs={finding.durationMs}
                musicalKey={formatKey(finding.key, notation)}
              />
              {chip}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </li>
  );
}

// The chain row as a dnd-kit sortable — the drag path (a grab handle) layered over the
// keyboard up/down buttons (the accessibility path stays). Ported from the /admin/plans
// tracklist: PointerSensor + KeyboardSensor, the transform/transition style, reduced
// motion drops the transition at the source.
function SortableChainRow({
  actions,
  finding,
  notation,
  reducedMotion,
}: {
  actions: React.ReactNode;
  finding: TrackListItem;
  notation: KeyNotation;
  reducedMotion: boolean;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: rowId(finding),
  });

  return (
    <BuilderRow
      actions={actions}
      dragging={isDragging}
      finding={finding}
      leading={
        // The drag handle is the keyboard reorder path: a real focusable <button>
        // carrying dnd-kit's KeyboardSensor listeners. Space/Enter picks the row up,
        // Arrow Up/Down move it (sortableKeyboardCoordinates), Space/Enter drops, Esc
        // cancels — and dnd-kit's live-region announcements (below) narrate each step.
        <button
          aria-label={`Reorder ${finding.title}`}
          className="inline-flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          {...attributes}
          {...listeners}
        >
          <DotsSixVerticalIcon aria-hidden="true" className="size-4" />
        </button>
      }
      notation={notation}
      rowRef={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: reducedMotion ? undefined : transition,
      }}
    />
  );
}

async function fetchMixable(tailLogId: string, exclude: string[]): Promise<MixableCandidate[]> {
  const params = new URLSearchParams({ limit: "12" });

  if (exclude.length > 0) {
    params.set("exclude", exclude.join(","));
  }

  const response = await fetch(
    `/api/v1/tracks/${encodeURIComponent(tailLogId)}/mixable?${params.toString()}`,
  );

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { findings?: MixableCandidate[] };

  return body.findings ?? [];
}

async function fetchFindingPool(): Promise<TrackListItem[]> {
  const response = await fetch("/api/v1/tracks?limit=48");

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { tracks?: FeedItem[] };

  return (body.tracks ?? []).filter(
    (item): item is TrackListItem => item.type !== "mixtape" && Boolean(item.logId),
  );
}

export function MixBuilder({
  initialChain,
  onPromote,
  onSetChange,
  readOnly,
}: {
  initialChain: TrackListItem[];
  /** Read-only → editable ("Chain your own set from here"). */
  onPromote: () => void;
  /** Sync the ordered chain to the `?set=` URL (masked replace, no loader rerun). */
  onSetChange: (logIds: string[]) => void;
  readOnly: boolean;
}) {
  const [chain, setChain] = useState<TrackListItem[]>(initialChain);

  const chainLogIds = useMemo(
    () => chain.map((finding) => finding.logId).filter((id): id is string => Boolean(id)),
    [chain],
  );

  const mutate = useCallback(
    (next: TrackListItem[]) => {
      setChain(next);
      onSetChange(next.map((finding) => finding.logId).filter((id): id is string => Boolean(id)));
    },
    [onSetChange],
  );

  const add = useCallback(
    (finding: TrackListItem) => {
      if (chain.some((existing) => existing.logId === finding.logId)) {
        return;
      }

      mutate([...chain, finding]);
    },
    [chain, mutate],
  );

  const remove = useCallback(
    (logId: string) => mutate(chain.filter((finding) => finding.logId !== logId)),
    [chain, mutate],
  );

  const { notation } = useKeyNotation();

  // Drag-to-reorder is the ONLY reorder path (the per-row up/down buttons were retired).
  // The keyboard path is the drag handle itself: dnd-kit's KeyboardSensor +
  // sortableKeyboardCoordinates make Space/Enter pick up a focused handle and Arrow
  // Up/Down move it, with the live-region `announcements` below narrating each step.
  // Same sensors + arrayMove as the /admin/plans tracklist; reduced motion drops the
  // sortable transition.
  const reducedMotion = usePrefersReducedMotion();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Position-aware screen-reader narration for the keyboard drag (dnd-kit reads these
  // out of a polite live region). `titleOf`/`positionOf` resolve the dragged/over row
  // from its sortable id so the announcement names the finding and its 1-based slot.
  const announcements = useMemo(() => {
    const titleOf = (id: string | number) =>
      chain.find((finding) => rowId(finding) === id)?.title ?? "the track";
    const positionOf = (id: string | number) =>
      chain.findIndex((finding) => rowId(finding) === id) + 1;

    return {
      onDragCancel: ({ active }: { active: { id: string | number } }) =>
        `Reorder cancelled. ${titleOf(active.id)} stayed where it was.`,
      onDragEnd: ({
        active,
        over,
      }: {
        active: { id: string | number };
        over: { id: string | number } | null;
      }) =>
        over
          ? `${titleOf(active.id)} landed at position ${positionOf(over.id)} of ${chain.length}.`
          : `${titleOf(active.id)} dropped.`,
      onDragOver: ({
        active,
        over,
      }: {
        active: { id: string | number };
        over: { id: string | number } | null;
      }) =>
        over
          ? `${titleOf(active.id)} moved to position ${positionOf(over.id)} of ${chain.length}.`
          : undefined,
      onDragStart: ({ active }: { active: { id: string | number } }) =>
        `Picked up ${titleOf(active.id)}. Use the arrow keys to reorder, space to drop.`,
    };
  }, [chain]);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      if (!over || active.id === over.id) {
        return;
      }

      const from = chain.findIndex((finding) => rowId(finding) === active.id);
      const to = chain.findIndex((finding) => rowId(finding) === over.id);

      if (from === -1 || to === -1) {
        return;
      }

      mutate(arrayMove(chain, from, to));
    },
    [chain, mutate],
  );

  const tail = chainLogIds[chainLogIds.length - 1];

  // The rail off the chain's tail, excluding the whole chain server-side (§3.1).
  const { data: candidates = [] } = useQuery({
    enabled: !readOnly && Boolean(tail),
    queryFn: () => (tail ? fetchMixable(tail, chainLogIds) : Promise.resolve([])),
    queryKey: ["mixable", tail, chainLogIds.length],
  });

  // Every previewable row (chain ∪ candidates) is a lookup source for the bottom bar,
  // which resolves the singleton's active id back to a finding for its metadata.
  const previewFindings = useMemo<TrackListItem[]>(
    () => [...chain, ...candidates],
    [chain, candidates],
  );

  // While a preview is mounted, the fixed bar overlays the viewport bottom. Reserve
  // matching space at the foot of the plate so it never covers the last row.
  const { activeTrackId } = usePreviewControls();

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      {chain.length === 0 ? (
        <MixPicker onPick={add} />
      ) : (
        <>
          {/* The chain, a flat plate-field pane on the plate (One Pane). */}
          {readOnly ? (
            <ol className="plate-field m-0 list-none divide-y divide-border rounded-md border border-border p-0">
              {chain.map((finding) => (
                <BuilderRow finding={finding} key={rowId(finding)} notation={notation} />
              ))}
            </ol>
          ) : (
            <DndContext
              accessibility={{ announcements }}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
              sensors={sensors}
            >
              <SortableContext
                items={chain.map((finding) => rowId(finding))}
                strategy={verticalListSortingStrategy}
              >
                <ol className="plate-field m-0 list-none divide-y divide-border rounded-md border border-border p-0">
                  {chain.map((finding) => (
                    <SortableChainRow
                      actions={
                        <Button
                          aria-label={`Take ${finding.title} out of the set`}
                          onClick={() => finding.logId && remove(finding.logId)}
                          size="icon"
                          variant="ghost"
                        >
                          <XIcon className="size-4" />
                        </Button>
                      }
                      finding={finding}
                      key={rowId(finding)}
                      notation={notation}
                      reducedMotion={reducedMotion}
                    />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          )}

          {readOnly ? (
            <Button className="self-start" onClick={onPromote} variant="default">
              Chain your own set from here
            </Button>
          ) : undefined}
        </>
      )}

      {!readOnly && chain.length > 0 ? (
        <section aria-label="Tracks ranked to mix in next">
          {/* A small bold label — never uppercase-tracked (a DESIGN.md Don't). */}
          <h2 className="mb-2 px-1 text-xs font-bold text-muted-foreground">
            What mixes in next, ranked
          </h2>
          {candidates.length > 0 ? (
            <ul className="plate-field m-0 list-none divide-y divide-border rounded-md border border-border p-0">
              {candidates.map((candidate) => (
                <BuilderRow
                  actions={
                    <Button
                      aria-label={`Add ${candidate.title} to the set`}
                      onClick={() => add(candidate)}
                      size="icon"
                      variant="ghost"
                    >
                      <PlusIcon className="size-4" />
                    </Button>
                  }
                  chip={<Badge variant="secondary">{mixReasonLabel(candidate.reason)}</Badge>}
                  finding={candidate}
                  key={rowId(candidate)}
                  notation={notation}
                />
              ))}
            </ul>
          ) : (
            <p className="px-1 text-sm text-muted-foreground">
              Nothing keys up cleanly to this one yet. Quiet sector tonight.
            </p>
          )}
        </section>
      ) : null}

      {/* Keep the last row clear of the fixed preview bar while it's mounted. */}
      {activeTrackId ? <div aria-hidden="true" className="h-20" /> : null}

      <MixPreviewBar findings={previewFindings} notation={notation} />
    </div>
  );
}

// The cold-start picker — a command-combobox over the recent findings (§3.3.1). Pick
// one to seed the chain; the rail takes over from there.
function MixPicker({ onPick }: { onPick: (finding: TrackListItem) => void }) {
  const { data: pool = [] } = useQuery({
    queryFn: fetchFindingPool,
    queryKey: ["mix-pool"],
    staleTime: 60_000,
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Pick the finding you want to open with. From there I rank what mixes in cleanly next.
      </p>
      <Command className="rounded-lg border border-border">
        <CommandInput placeholder="Search the findings…" />
        <CommandList>
          <CommandEmpty>No finding by that name.</CommandEmpty>
          <CommandGroup>
            {pool.map((finding) => (
              <CommandItem
                key={rowId(finding)}
                onSelect={() => onPick(finding)}
                value={`${finding.artists.join(" ")} ${finding.title} ${finding.logId ?? ""}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {finding.artists.join(", ")} — {finding.title}
                </span>
                <span className="track-log-id shrink-0">{finding.logId}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
