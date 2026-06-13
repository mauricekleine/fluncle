import { CheckCircleIcon, CircleNotchIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { VibeMap, VIBE_QUADRANTS, vibeQuadrant } from "@/components/admin/vibe-map";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  decodeTrackCursor,
  listTracks,
  listVibePoints,
  type TrackListItem,
  type VibePoint,
} from "@/lib/server/tracks";
import { usePreviewPlayer } from "@/lib/preview-player";
import { cn } from "@/lib/utils";

// The admin tagging tool: pick a finding, drop it on the vibe map relative to
// the others, Save/Next writes its (x, y) and advances. Reads go through gated
// server functions calling listTracks; the write goes through the existing PATCH
// (now cookie-aware + coordinate-aware). See docs/admin-tagging.md.

const QUEUE_PAGE_SIZE = 50;
// How far an arrow-key nudge moves the marker, in the -1..1 vibe space.
const NUDGE = 0.05;

type Placement = "placed" | "unplaced";
type Pos = { x: number; y: number };

type QueuePage = {
  nextCursor?: string;
  tracks: TrackListItem[];
};

// A beforeLoad/server-function guard only protects the page render, not the RPC
// behind a server function — so every admin server function re-checks the grant.
const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchQueue = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; placement: Placement }) => data)
  .handler(async ({ data }): Promise<QueuePage> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const page = await listTracks({
      cursor: decodeTrackCursor(data.cursor ?? null),
      limit: QUEUE_PAGE_SIZE,
      // Oldest unplaced first (work the backlog in found order); placed review
      // reads newest-first.
      order: data.placement === "unplaced" ? "asc" : "desc",
      placement: data.placement,
    });

    return { nextCursor: page.nextCursor, tracks: page.tracks };
  });

const fetchPoints = createServerFn({ method: "GET" }).handler(async (): Promise<VibePoint[]> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return listVibePoints();
});

export const Route = createFileRoute("/admin/tag")({
  beforeLoad: async () => {
    await ensureAdmin();
  },
  component: AdminTagPage,
  loader: async () => {
    const [queue, points] = await Promise.all([
      fetchQueue({ data: { placement: "unplaced" } }),
      fetchPoints(),
    ]);

    return { points, queue };
  },
});

const clamp = (n: number) => Math.max(-1, Math.min(1, n));

function AdminTagPage() {
  const initial = Route.useLoaderData();
  const [placement, setPlacement] = useState<Placement>("unplaced");
  const [tracks, setTracks] = useState<TrackListItem[]>(initial.queue.tracks);
  const [nextCursor, setNextCursor] = useState<string | undefined>(initial.queue.nextCursor);
  const [points, setPoints] = useState<VibePoint[]>(initial.points);
  const [index, setIndex] = useState(0);
  const [pos, setPos] = useState<Pos | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const track = tracks[index];

  // Seed the marker from the track's stored placement (so review/move shows where
  // it already sits); an unplaced track starts with no marker until you drop it.
  useEffect(() => {
    if (track && track.vibeX !== undefined && track.vibeY !== undefined) {
      setPos({ x: track.vibeX, y: track.vibeY });
    } else {
      setPos(null);
    }

    setError(undefined);
  }, [track]);

  const switchQueue = useCallback(async (next: Placement) => {
    setError(undefined);
    setPlacement(next);

    try {
      const page = await fetchQueue({ data: { placement: next } });
      setTracks(page.tracks);
      setNextCursor(page.nextCursor);
      setIndex(0);
      setSavedIds(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!nextCursor || loadingMore) {
      return false;
    }

    setLoadingMore(true);

    try {
      const page = await fetchQueue({ data: { cursor: nextCursor, placement } });
      setTracks((current) => [...current, ...page.tracks]);
      setNextCursor(page.nextCursor);
      return page.tracks.length > 0;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, placement]);

  const goTo = useCallback(
    async (target: number) => {
      if (target < 0) {
        return;
      }

      if (target >= tracks.length) {
        const grew = await loadMore();

        if (!grew) {
          return;
        }
      }

      setIndex(target);
    },
    [loadMore, tracks.length],
  );

  const nudge = useCallback((dx: number, dy: number) => {
    setPos((current) => {
      const base = current ?? { x: 0, y: 0 };

      return { x: clamp(base.x + dx), y: clamp(base.y + dy) };
    });
  }, []);

  const saveAndNext = useCallback(async () => {
    if (!track || saving || !pos) {
      return;
    }

    setSaving(true);
    setError(undefined);

    try {
      const response = await fetch(`/api/admin/tracks/${track.trackId}`, {
        body: JSON.stringify({ vibeX: pos.x, vibeY: pos.y }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });

      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`);
      }

      setPoints((current) => [
        ...current.filter((point) => point.trackId !== track.trackId),
        {
          artists: track.artists,
          title: track.title,
          trackId: track.trackId,
          vibeX: pos.x,
          vibeY: pos.y,
        },
      ]);
      setSavedIds((current) => new Set(current).add(track.trackId));
      await goTo(index + 1);
    } catch (caught) {
      // Keep the placement on failure; do not advance.
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }, [goTo, index, pos, saving, track]);

  const player = usePreviewPlayer(track?.trackId ?? "");

  // The keyboard loop (documented in docs/admin-tagging.md): arrows nudge the
  // marker, [ ] step tracks, Enter saves, K plays, L switches the list.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          nudge(-NUDGE, 0);
          break;
        case "ArrowRight":
          event.preventDefault();
          nudge(NUDGE, 0);
          break;
        case "ArrowUp":
          event.preventDefault();
          nudge(0, NUDGE);
          break;
        case "ArrowDown":
          event.preventDefault();
          nudge(0, -NUDGE);
          break;
        case "[":
          event.preventDefault();
          void goTo(index - 1);
          break;
        case "]":
          event.preventDefault();
          void goTo(index + 1);
          break;
        case "Enter":
          event.preventDefault();
          void saveAndNext();
          break;
        case "k":
          event.preventDefault();
          player.toggle();
          break;
        case "l":
          event.preventDefault();
          void switchQueue(placement === "unplaced" ? "placed" : "unplaced");
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goTo, index, nudge, placement, player, saveAndNext, switchQueue]);

  const remaining = useMemo(
    () => tracks.filter((candidate) => !savedIds.has(candidate.trackId)).length,
    [savedIds, tracks],
  );
  const contextPoints = useMemo(
    () => points.filter((point) => point.trackId !== track?.trackId),
    [points, track],
  );
  const quadrant = pos ? vibeQuadrant(pos.x, pos.y) : undefined;
  const total = tracks.length;

  return (
    <main className="min-h-dvh p-3 text-foreground sm:p-4 lg:h-dvh lg:overflow-hidden lg:p-6">
      {/* One contained surface over the ambient cosmos, so the tool reads as a
          calm panel instead of floating on the starfield/turntable backdrop. */}
      <div className="mx-auto flex min-h-0 w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-border bg-card/80 outline outline-1 outline-border/40 outline-offset-4 backdrop-blur-xl lg:h-full">
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h1 className="text-sm font-bold">Tag tracks</h1>
            <p className="text-xs text-muted-foreground">
              {placement === "unplaced" ? "Needs review" : "Placed"}
              {track ? ` · ${index + 1} of ${total}${nextCursor ? "+" : ""}` : ""} · {remaining}{" "}
              left
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              onClick={() => void switchQueue(placement === "unplaced" ? "placed" : "unplaced")}
              size="sm"
              variant="outline"
            >
              {placement === "unplaced" ? "Show placed" : "Show needs review"}
              <kbd className="ml-1 rounded border border-border bg-muted px-1 font-sans text-[10px] leading-tight text-muted-foreground">
                L
              </kbd>
            </Button>
            <AdminNav current="tag" />
          </div>
        </header>

        {error ? (
          <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-5">
            {error}
          </p>
        ) : undefined}

        {track ? (
          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(220px,260px)_minmax(0,1fr)_minmax(240px,300px)]">
            {/* LEFT: cover + preview + shortcuts */}
            <section className="flex flex-col gap-4 p-4 sm:p-5">
              <div className="cover-frame rounded-lg border p-1">
                <img
                  alt={`${track.title} cover`}
                  className="aspect-square w-full rounded-lg object-cover"
                  src={track.albumImageUrl ?? "/fluncle-cover.png"}
                />
              </div>
              <div className="min-w-0">
                <p className="truncate font-bold">{track.title}</p>
                <p className="truncate text-sm text-muted-foreground">{track.artists.join(", ")}</p>
              </div>
              <Button
                disabled={!track.previewUrl}
                onClick={player.toggle}
                size="lg"
                variant="outline"
              >
                {player.isLoading ? (
                  <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                ) : player.isActive ? (
                  <PauseIcon aria-hidden="true" weight="fill" />
                ) : (
                  <PlayIcon aria-hidden="true" weight="fill" />
                )}
                {track.previewUrl ? (player.isActive ? "Pause" : "Play preview") : "No preview"}
                <kbd className="ml-auto rounded border border-border bg-muted px-1 font-sans text-[10px] leading-tight text-muted-foreground">
                  K
                </kbd>
              </Button>
              <dl className="mt-auto hidden gap-1.5 border-t border-border pt-4 text-xs text-muted-foreground lg:grid">
                {[
                  ["Place / nudge", "← ↑ ↓ →"],
                  ["Play / pause", "K"],
                  ["Save & next", "⏎"],
                  ["Prev / next", "[ ]"],
                  ["Switch list", "L"],
                ].map(([action, keys]) => (
                  <div className="flex items-center justify-between gap-2" key={action}>
                    <dt>{action}</dt>
                    <dd className="rounded border border-border bg-muted px-1.5 font-sans text-[10px] leading-relaxed">
                      {keys}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* MIDDLE: the vibe map + pinned action bar */}
            <section className="flex min-h-0 flex-col border-border lg:border-l">
              <div className="flex flex-1 items-center justify-center overflow-auto p-4 sm:p-6">
                <VibeMap onChange={(x, y) => setPos({ x, y })} points={contextPoints} value={pos} />
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-5">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {quadrant ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="size-2.5 rounded-full"
                        style={{ background: VIBE_QUADRANTS[quadrant].color }}
                      />
                      Placing in {VIBE_QUADRANTS[quadrant].label}
                    </>
                  ) : (
                    "Click the map to place this banger"
                  )}
                </span>
                <Button disabled={saving || !pos} onClick={() => void saveAndNext()} size="lg">
                  {saving ? "Saving…" : "Save & next"}
                  <kbd className="ml-1 rounded border border-primary-foreground/30 px-1 font-sans text-[10px] leading-tight text-primary-foreground/80">
                    ⏎
                  </kbd>
                </Button>
              </div>
            </section>

            {/* RIGHT: queue jump list */}
            <aside className="flex min-h-0 flex-col border-border lg:border-l">
              <p className="border-b border-border px-4 py-2.5 text-xs font-bold text-muted-foreground sm:px-5">
                Queue
              </p>
              <ScrollArea className="max-h-[45vh] min-h-0 lg:max-h-none lg:flex-1">
                <ol className="m-0 list-none p-0">
                  {tracks.map((candidate, candidateIndex) => (
                    <li key={candidate.trackId}>
                      <button
                        className={cn(
                          "flex w-full items-center gap-2 px-4 py-2 text-left text-sm outline-none transition-colors duration-150 ease-out focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none sm:px-5",
                          candidateIndex === index
                            ? "bg-accent text-accent-foreground"
                            : "hover:bg-accent/40",
                        )}
                        onClick={() => setIndex(candidateIndex)}
                        type="button"
                      >
                        {savedIds.has(candidate.trackId) ? (
                          <CheckCircleIcon
                            aria-label="Saved"
                            className="shrink-0 text-primary"
                            weight="fill"
                          />
                        ) : (
                          <span aria-hidden="true" className="size-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{candidate.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {candidate.artists.join(", ")}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {nextCursor ? (
                    <li>
                      <button
                        className="w-full px-4 py-2.5 text-center text-xs font-bold text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:opacity-50 sm:px-5"
                        disabled={loadingMore}
                        onClick={() => void loadMore()}
                        type="button"
                      >
                        {loadingMore ? "Loading…" : "Load more"}
                      </button>
                    </li>
                  ) : undefined}
                </ol>
              </ScrollArea>
              <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 sm:px-5">
                <Button
                  className="flex-1"
                  disabled={index === 0}
                  onClick={() => void goTo(index - 1)}
                  size="sm"
                  variant="outline"
                >
                  Prev
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => void goTo(index + 1)}
                  size="sm"
                  variant="outline"
                >
                  Next
                </Button>
              </div>
            </aside>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-20 text-center">
            <p className="font-medium">
              {placement === "unplaced" ? "Nothing to place" : "No placed tracks yet"}
            </p>
            <p className="text-sm text-muted-foreground">
              {placement === "unplaced"
                ? "Every find has a place in the Galaxy."
                : "Placed tracks will show up here."}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
