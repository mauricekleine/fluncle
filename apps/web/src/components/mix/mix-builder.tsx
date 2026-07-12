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
import { type MixCandidate, type MixTrack } from "@fluncle/contracts";
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
import { TastePicker } from "@/components/mix/taste-picker";
import { SpotifyIcon } from "@/components/platform-icons";
import { TrackArtwork } from "@/components/track-artwork";
import { TrackChips } from "@/components/track-row";
import { formatKey, type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { mixReasonLabel, serializeTaste, setToken } from "@/lib/mix-set";
import { usePreviewControls } from "@/lib/preview-player";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

// The `/mix` plate: one printed logbook page — a stranger taking the decks with Fluncle's
// archive. NOT a SaaS builder. The design invariants are gates: exactly ONE gold primary
// (Copy set link); no numeric score ever reaches the crew (only the reason chip); a builder-
// row variant (not TrackRow's stretched link); reorder by keyboard through the drag handle.
//
// THE UNLIT RULE (DESIGN.md) LIVES ON EVERY ROW HERE. A row is a track Fluncle certified (a
// finding: it carries its coordinate, it lights gold, it previews, and it links to `/log`) or
// one he never did (it carries no coordinate, catches the cold Dust Veil, and links OUT to
// Spotify, because there is nowhere else to send you). The difference is the REGISTER and
// never a word: no badge, no label, no noun, and no heading naming the tier. Every heading
// over a mixed list names the SUPERSET ("Tracks"), which is true of every row under it.
//
// A catalogue row cannot leak a coordinate even by accident: `MixTrack` has no `logId` unless
// it is certified (see MixTrackSchema), so the lit register is unreachable without one.

/** A track's stable identity for React keys and drag-and-drop — its `?set=` token. */
const rowId = (track: MixTrack): string => setToken(track);

const artworkUrl = (track: MixTrack): string | undefined =>
  albumCoverAtSize(track.albumImageUrl, "small");

// The album artwork doubles as a preview control on a CERTIFIED row: a play/pause overlay
// that previews via the shared `/api/preview/<logId>` relay. An uncertified row has no
// coordinate, so it has no relay and no preview — its artwork is a plain, dimmed square, and
// the way to hear it is the Spotify link. That silence is not a limitation to apologise for;
// it is the same statement the register already makes.
function PreviewArtwork({ logId, track }: { logId: string; track: MixTrack }) {
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
      <TrackArtwork alt="" src={artworkUrl(track)} />
      <button
        aria-label={isPlaying ? "Pause" : `Play the preview of ${track.title}`}
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

// A builder row — the TrackRow grid skeleton WITHOUT the stretched navigation link, so Add /
// remove / reorder each own their own hit target. `leading` mounts a drag handle ahead of the
// artwork; `rowRef`/`style`/`dragging` let a sortable wrapper drive the <li>.
function BuilderRow({
  actions,
  chip,
  dragging = false,
  leading,
  notation,
  rowRef,
  style,
  track,
}: {
  actions?: React.ReactNode;
  chip?: React.ReactNode;
  dragging?: boolean;
  leading?: React.ReactNode;
  notation: KeyNotation;
  rowRef?: (element: HTMLLIElement | null) => void;
  style?: CSSProperties;
  track: MixTrack;
}) {
  const hasTelemetry = Boolean(track.durationMs || track.bpm || track.key);
  const logId = track.certified ? track.logId : undefined;

  return (
    <li
      className={cn(
        "mix-row flex items-center gap-3 px-3 py-2.5",
        !track.certified && "mix-row--unlit",
        dragging && "relative z-10 bg-muted",
      )}
      ref={rowRef}
      style={style}
    >
      {leading}
      <div className="min-w-0 flex flex-1 items-center gap-3">
        {logId ? (
          <PreviewArtwork logId={logId} track={track} />
        ) : (
          <TrackArtwork alt="" src={artworkUrl(track)} />
        )}
        <div className="min-w-0 flex-1">
          {logId ? (
            // The coordinate, in the canon numeric face (Oxanium tabular) and lit gold —
            // because it IS the certification. An unlit row has none, and gets none.
            <Link
              className="track-log-id track-log-id-link block truncate"
              params={{ logId }}
              to="/log/$logId"
            >
              {logId}
            </Link>
          ) : null}
          <p className="mix-row-title truncate text-sm font-medium">{track.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {track.artists.join(", ")}
          </p>
          {hasTelemetry || chip ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <TrackChips
                bpm={track.bpm}
                className="m-0"
                durationMs={track.durationMs}
                musicalKey={formatKey(track.key, notation)}
              />
              {chip}
            </div>
          ) : null}
        </div>
      </div>
      {/* The way out, on an unlit row only: there is no /log page for a track Fluncle has
          not been to, so the row leaves for the one place it can be heard. A crawler-minted
          row may have no Spotify presence at all — then there is no way out, and the row
          simply doesn't offer one (never a dead link). */}
      {!track.certified && track.spotifyUrl ? (
        <a
          aria-label={`Open ${track.title} on Spotify`}
          className="mix-row-out"
          href={track.spotifyUrl}
          rel="noreferrer"
          target="_blank"
        >
          <SpotifyIcon aria-hidden="true" className="size-4" />
        </a>
      ) : null}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </li>
  );
}

// The chain row as a dnd-kit sortable — the drag path (a grab handle) that is ALSO the
// keyboard path (KeyboardSensor + sortableKeyboardCoordinates): Space/Enter picks a focused
// handle up, Arrow Up/Down move it, and dnd-kit's live region narrates each step.
function SortableChainRow({
  actions,
  notation,
  reducedMotion,
  track,
}: {
  actions: React.ReactNode;
  notation: KeyNotation;
  reducedMotion: boolean;
  track: MixTrack;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: rowId(track),
  });

  return (
    <BuilderRow
      actions={actions}
      dragging={isDragging}
      leading={
        <button
          aria-label={`Reorder ${track.title}`}
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
      track={track}
    />
  );
}

async function fetchMixable(
  tailToken: string,
  exclude: string[],
  taste: string[],
): Promise<MixCandidate[]> {
  const params = new URLSearchParams({ limit: "12" });

  if (exclude.length > 0) {
    params.set("exclude", exclude.join(","));
  }
  if (taste.length > 0) {
    params.set("taste", serializeTaste(taste));
  }

  const response = await fetch(
    `/api/v1/tracks/${encodeURIComponent(tailToken)}/mixable?${params.toString()}`,
  );

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { findings?: MixCandidate[] };

  return body.findings ?? [];
}

async function fetchOpeners(taste: string[]): Promise<MixTrack[]> {
  if (taste.length === 0) {
    return [];
  }

  const params = new URLSearchParams({ limit: "24", taste: serializeTaste(taste) });
  const response = await fetch(`/api/v1/mix/openers?${params.toString()}`);

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { tracks?: MixTrack[] };

  return body.tracks ?? [];
}

async function searchMixTracks(q: string): Promise<MixTrack[]> {
  const response = await fetch(`/api/v1/search/archive?q=${encodeURIComponent(q)}&limit=24`);

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as {
    results?: {
      albumImageUrl?: string;
      artists: string[];
      certified: boolean;
      logId?: string;
      spotifyUrl?: string;
      title: string;
      trackId: string;
    }[];
  };

  // Search returns its own hit shape; the pieces a chain row needs are the same, and the two
  // durations/keys it lacks arrive with the rail once the chain has a tail.
  return (body.results ?? []).map((hit) => ({
    albumImageUrl: hit.albumImageUrl,
    artists: hit.artists,
    certified: hit.certified,
    durationMs: 0,
    logId: hit.certified ? hit.logId : undefined,
    spotifyUrl: hit.spotifyUrl,
    title: hit.title,
    trackId: hit.trackId,
  }));
}

export function MixBuilder({
  initialChain,
  onPromote,
  onSetChange,
  onTasteChange,
  readOnly,
  taste,
}: {
  initialChain: MixTrack[];
  /** Read-only → editable ("Chain your own set from here"). */
  onPromote: () => void;
  /** Sync the ordered chain to `?set=` (masked replace, no loader rerun). */
  onSetChange: (tokens: string[]) => void;
  /** Sync the taste seed to `?taste=`. */
  onTasteChange: (slugs: string[]) => void;
  readOnly: boolean;
  /** The seeded artist slugs, from `?taste=`. */
  taste: string[];
}) {
  const [chain, setChain] = useState<MixTrack[]>(initialChain);
  // "I don't want to seed, just let me search" — a session-local escape from the picker.
  const [skippedSeeding, setSkippedSeeding] = useState(false);
  // Re-opening the picker on a live seed ("Change artists").
  const [reseeding, setReseeding] = useState(false);

  const chainTokens = useMemo(() => chain.map(setToken), [chain]);

  const mutate = useCallback(
    (next: MixTrack[]) => {
      setChain(next);
      onSetChange(next.map(setToken));
    },
    [onSetChange],
  );

  const add = useCallback(
    (track: MixTrack) => {
      if (chain.some((existing) => setToken(existing) === setToken(track))) {
        return;
      }

      mutate([...chain, track]);
    },
    [chain, mutate],
  );

  const remove = useCallback(
    (token: string) => mutate(chain.filter((track) => setToken(track) !== token)),
    [chain, mutate],
  );

  const { notation } = useKeyNotation();
  const reducedMotion = usePrefersReducedMotion();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Position-aware screen-reader narration for the keyboard drag (dnd-kit reads these out of
  // a polite live region).
  const announcements = useMemo(() => {
    const titleOf = (id: string | number) =>
      chain.find((track) => rowId(track) === id)?.title ?? "the track";
    const positionOf = (id: string | number) => chain.findIndex((track) => rowId(track) === id) + 1;

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

      const from = chain.findIndex((track) => rowId(track) === active.id);
      const to = chain.findIndex((track) => rowId(track) === over.id);

      if (from === -1 || to === -1) {
        return;
      }

      mutate(arrayMove(chain, from, to));
    },
    [chain, mutate],
  );

  const tail = chainTokens[chainTokens.length - 1];

  // The rail off the chain's tail, excluding the whole chain server-side, tilted by taste.
  const { data: candidates = [] } = useQuery({
    enabled: !readOnly && Boolean(tail),
    queryFn: () => (tail ? fetchMixable(tail, chainTokens, taste) : Promise.resolve([])),
    queryKey: ["mixable", tail, chainTokens.length, serializeTaste(taste)],
  });

  // Every previewable row (chain ∪ candidates) is a lookup source for the bottom bar.
  const previewTracks = useMemo<MixTrack[]>(() => [...chain, ...candidates], [chain, candidates]);
  const { activeTrackId } = usePreviewControls();

  const seedTaste = useCallback(
    (slugs: string[]) => {
      onTasteChange(slugs);
      setReseeding(false);
    },
    [onTasteChange],
  );

  const showPicker =
    !readOnly && chain.length === 0 && (reseeding || (!taste.length && !skippedSeeding));

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      {showPicker ? (
        <TastePicker
          onSeed={seedTaste}
          onSkip={() => {
            setSkippedSeeding(true);
            setReseeding(false);
          }}
          seeded={taste}
        />
      ) : null}

      {!showPicker && !readOnly && chain.length === 0 ? (
        taste.length > 0 ? (
          <MixOpeners onChangeArtists={() => setReseeding(true)} onPick={add} taste={taste} />
        ) : (
          <MixSearchPicker onPick={add} />
        )
      ) : null}

      {chain.length > 0 ? (
        <>
          {/* The chain, a flat plate-field pane on the plate (One Pane). */}
          {readOnly ? (
            <ol className="plate-field m-0 list-none divide-y divide-border rounded-md border border-border p-0">
              {chain.map((track) => (
                <BuilderRow key={rowId(track)} notation={notation} track={track} />
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
                items={chain.map((track) => rowId(track))}
                strategy={verticalListSortingStrategy}
              >
                <ol className="plate-field m-0 list-none divide-y divide-border rounded-md border border-border p-0">
                  {chain.map((track) => (
                    <SortableChainRow
                      actions={
                        <Button
                          aria-label={`Take ${track.title} out of the set`}
                          onClick={() => remove(setToken(track))}
                          size="icon"
                          variant="ghost"
                        >
                          <XIcon className="size-4" />
                        </Button>
                      }
                      key={rowId(track)}
                      notation={notation}
                      reducedMotion={reducedMotion}
                      track={track}
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
      ) : null}

      {!readOnly && chain.length > 0 ? (
        <section aria-label="Tracks ranked to mix in next">
          {/* A small bold label — never uppercase-tracked (a DESIGN.md Don't). The heading
              names what the list DOES, not what its rows are, so it stays true over a list
              that mixes certified rows with ones Fluncle has never been to. */}
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
                  key={rowId(candidate)}
                  notation={notation}
                  track={candidate}
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

      <MixPreviewBar notation={notation} tracks={previewTracks} />
    </div>
  );
}

// What to open with, once the reader has named the artists they like: those artists' own
// tracks, certified first. The heading names the ACTION, never the tier of the rows under it.
function MixOpeners({
  onChangeArtists,
  onPick,
  taste,
}: {
  onChangeArtists: () => void;
  onPick: (track: MixTrack) => void;
  taste: string[];
}) {
  const { notation } = useKeyNotation();
  const { data: openers = [], isPending } = useQuery({
    queryFn: () => fetchOpeners(taste),
    queryKey: ["mix-openers", serializeTaste(taste)],
    staleTime: 60_000,
  });

  return (
    <section aria-label="Tracks to open the set with" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold">Open with</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Tracks by the artists you named. Pick one and I rank what mixes in after it.
          </p>
        </div>
        <Button className="px-0" onClick={onChangeArtists} variant="link">
          Change artists
        </Button>
      </div>

      {openers.length > 0 ? (
        <ul className="plate-field m-0 list-none divide-y divide-border rounded-md border border-border p-0">
          {openers.map((track) => (
            <BuilderRow
              actions={
                <Button
                  aria-label={`Open the set with ${track.title}`}
                  onClick={() => onPick(track)}
                  size="icon"
                  variant="ghost"
                >
                  <PlusIcon className="size-4" />
                </Button>
              }
              key={rowId(track)}
              notation={notation}
              track={track}
            />
          ))}
        </ul>
      ) : isPending ? null : (
        <p className="px-1 text-sm text-muted-foreground">
          I have nothing on those artists I can place yet. Pick another few, or search for a track
          yourself.
        </p>
      )}
    </section>
  );
}

// The un-seeded cold start: search the archive for something to open with. The placeholder
// and the empty state say "track", the superset noun — the list mixes findings with rows
// Fluncle has never been to, and naming either tier over it would be a false claim.
function MixSearchPicker({ onPick }: { onPick: (track: MixTrack) => void }) {
  const [q, setQ] = useState("");
  const { data: results = [] } = useQuery({
    enabled: q.trim().length > 1,
    queryFn: () => searchMixTracks(q),
    queryKey: ["mix-search", q],
    staleTime: 30_000,
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Find a track to open with. From there I rank what mixes in clean next.
      </p>
      <Command className="rounded-lg border border-border" shouldFilter={false}>
        <CommandInput onValueChange={setQ} placeholder="Search tracks" value={q} />
        <CommandList>
          {q.trim().length > 1 ? <CommandEmpty>Nothing by that name out here.</CommandEmpty> : null}
          <CommandGroup>
            {results.map((track) => (
              <CommandItem
                className={cn("search-row", !track.certified && "search-row--unlit")}
                key={rowId(track)}
                onSelect={() => onPick(track)}
                value={rowId(track)}
              >
                {/* `.search-row-title` so the unlit register dims the row to stardust at
                    rest, matching the certified/uncertified split everywhere else (search,
                    the openers, the rail) rather than leaving a full-cream title. */}
                <span className="search-row-title min-w-0 flex-1 truncate">
                  {track.artists.join(", ")} — {track.title}
                </span>
                {track.certified && track.logId ? (
                  <span className="search-row-coordinate shrink-0">{track.logId}</span>
                ) : (
                  <SpotifyIcon aria-hidden="true" className="search-row-out" />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
