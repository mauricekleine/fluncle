import {
  CircleNotchIcon,
  CrosshairIcon,
  NotePencilIcon,
  PlayIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { EnrichDialog } from "@/components/admin/enrich-dialog";
import { NoteDialog } from "@/components/admin/note-dialog";
import { type PlatformConfig, PLATFORMS } from "@/components/admin/platform-cell";
import { PushDialog } from "@/components/admin/push-dialog";
import { StageCell, type StageState } from "@/components/admin/stage-cell";
import { TagDialog } from "@/components/admin/tag-dialog";
import { type BoardPage, type BoardRow, usePublish } from "@/components/admin/use-publish";
import { StoriesPlayer } from "@/components/stories/stories-player";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { GALAXIES, galaxyForVibe } from "@/lib/galaxies";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { readCaptions } from "@/lib/server/captions";
import { listSocialPostsForTracks } from "@/lib/server/social";
import { triggerEnrichment } from "@/lib/server/spinup";
import { getSpotifyAuthStatus, type SpotifyAuthStatus } from "@/lib/server/spotify";
import { type BlockedOn, trackStage } from "@/lib/server/track-stage";
import { decodeTrackCursor, listTracks, listVibePoints, type VibePoint } from "@/lib/server/tracks";
import { cn } from "@/lib/utils";

// The pipeline checklist — the operator's `/admin` home. Every finding is a row;
// every PIPELINE STAGE is a column (Enrich · Tag · YouTube · TikTok), and each
// cell is binary-legible: done, or the button that does it. The stages aren't a
// strict chain (tagging doesn't gate publishing, the two platforms go in either
// order), so each cell stands alone and carries its own state by SHAPE — hollow
// (open) → dashed (in flight / pushed-not-live) → solid (done) — see StageCell.
//
// Rendering isn't a column: a finding either has a video (the cover wears the gold
// story-ring + play badge) or it doesn't ("no video"). That status lives in the
// Finding cell, where it already reads at a glance.
//
// Clicking a cell opens its stage dialog: Tag → the vibe map; Enrich → trigger the
// Spinup agent; YouTube/TikTok → the publish loop (copy caption + cover, push, then
// paste the live URL). Reads + writes go through the same gated admin API the CLI
// uses. This board is now the single admin surface — it folded in the old Posts and
// Tag pages.

const PAGE_SIZE = 50;

// The board's react-query cache key. Optimistic publish patches + window-focus
// refetch land on this one entry.
const BOARD_KEY = ["admin", "posts", "board"] as const;
// The placed-findings cache for the Tag dialog's map backdrop.
const POINTS_KEY = ["admin", "tag", "points"] as const;
// The Spotify connection-status cache for the reconnect banner.
const SPOTIFY_STATUS_KEY = ["admin", "spotify", "status"] as const;

// The two publish platforms, in pipeline order (YouTube posts public directly,
// TikTok lands as a draft you finish in-app). PLATFORMS is keyed the other way for
// the posting view; we pin the column order here.
const PUBLISH_PLATFORMS: PlatformConfig[] = ["youtube", "tiktok"].map(
  (key) => PLATFORMS.find((platform) => platform.key === key) as PlatformConfig,
);

// The worklists — a `blockedOn` filter (the next action) plus "all" and a "done"
// terminal bucket. The active one lives in `?stage` so it's deep-linkable and
// survives reload. The checklist columns show each stage's own state; this just
// narrows the rows to a focus ("show me everything still needing a video").
type Worklist = "all" | "needs-tagging" | "needs-video" | "ready-youtube" | "ready-tiktok" | "done";

const WORKLISTS: { blockedOn?: BlockedOn; key: Worklist; label: string }[] = [
  { key: "all", label: "All" },
  { blockedOn: "needs tagging", key: "needs-tagging", label: "Needs tagging" },
  { blockedOn: "needs a video", key: "needs-video", label: "Needs a video" },
  { blockedOn: "ready for YouTube", key: "ready-youtube", label: "Ready for YouTube" },
  { blockedOn: "ready for TikTok", key: "ready-tiktok", label: "Ready for TikTok" },
  { blockedOn: null, key: "done", label: "Live" },
];

const WORKLIST_KEYS = new Set(WORKLISTS.map((worklist) => worklist.key));

// Column template shared by the header + every row so they align: the Log ID
// (the finding's permanent identity, its own scannable column), the finding, then
// the four equal stage cells. Horizontal-scroll wrapper so a phone scrolls
// sideways rather than cramming.
const GRID =
  "grid grid-cols-[5.5rem_minmax(13rem,1fr)_repeat(5,minmax(6.5rem,8rem))] items-center gap-x-3";

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// Every admin server function re-checks the grant — the page guard only protects
// the render, not the RPC behind a server function.
const fetchBoard = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string }) => data)
  .handler(async ({ data }): Promise<BoardPage> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const page = await listTracks({
      cursor: decodeTrackCursor(data.cursor ?? null),
      limit: PAGE_SIZE,
      order: "desc",
    });
    // The batch social-post fetch — one query for the whole page, no N+1.
    const posts = await listSocialPostsForTracks(page.tracks.map((track) => track.trackId));

    return {
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
      tracks: page.tracks.map((track) => ({ ...track, posts: posts[track.trackId] ?? [] })),
    };
  });

// Lazy caption read — only when the operator copies a finding's caption, never
// preloaded for the whole page. Reads the public note.txt server-side (no CORS;
// works in dev too, the binding is just empty there).
const fetchCaption = createServerFn({ method: "GET" })
  .validator((data: { logId: string }) => data)
  .handler(async ({ data }): Promise<{ caption: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const captions = await readCaptions([data.logId]);

    return { caption: captions[data.logId] ?? "" };
  });

// The Spotify connection light. Read-only (no token refresh) and focus-refetched,
// so the moment a publish/search trips invalid_grant and clears the stored token,
// tabbing back to the board surfaces the Reconnect banner. See spotify.ts.
const fetchSpotifyStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<SpotifyAuthStatus> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return getSpotifyAuthStatus();
  },
);

// The placed-findings backdrop for the Tag dialog's map — lazily fetched the first
// time a Tag cell is opened (no preload), then cached + focus-refetched.
const fetchVibePoints = createServerFn({ method: "GET" }).handler(
  async (): Promise<VibePoint[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listVibePoints();
  },
);

// Kick the Spinup enrichment agent for one finding. triggerEnrichment is a fast
// enqueue that never throws and marks the record "processing" on a good enqueue;
// the agent flips it to "done" when it finishes (docs/track-lifecycle.md).
const triggerEnrichmentFn = createServerFn({ method: "POST" })
  .validator((data: { logId: string; trackId: string }) => data)
  .handler(async ({ data }) => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    await triggerEnrichment(data.trackId, data.logId);

    return { ok: true };
  });

type BoardSearch = { stage: Worklist };

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => ({
    stage:
      typeof search.stage === "string" && WORKLIST_KEYS.has(search.stage as Worklist)
        ? (search.stage as Worklist)
        : "all",
  }),
  beforeLoad: async () => {
    await ensureAdmin();
  },
  loader: async () => fetchBoard({ data: {} }),
  component: AdminBoardPage,
});

function AdminBoardPage() {
  const initial = Route.useLoaderData();
  const { stage: activeWorklist } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  // The board reads through react-query so it refetches on window focus — when the
  // operator tabs back from TikTok/YouTube, the per-platform statuses come back
  // fresh without a manual reload. Seeded with the SSR loader page so the first
  // paint is instant and no client fetch fires on mount.
  const {
    data,
    error: queryError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialData: { pageParams: [undefined], pages: [initial] },
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchBoard({ data: { cursor: pageParam } }),
    queryKey: BOARD_KEY,
    refetchOnWindowFocus: true,
  });

  const rows = useMemo(() => data?.pages.flatMap((page) => page.tracks) ?? [], [data]);
  const totalCount = data?.pages[0]?.totalCount ?? initial.totalCount;

  const { busy, error, pushDraft, setError, setStatus } = usePublish(BOARD_KEY);

  // Dialogs are keyed by identity (not a row snapshot) so they always render the
  // LIVE row — right after a push the cache patches, the row updates, and the open
  // dialog shows the next step without reopening.
  const [tagId, setTagId] = useState<string | undefined>();
  const [enrichId, setEnrichId] = useState<string | undefined>();
  const [push, setPush] = useState<{ platformKey: string; trackId: string } | undefined>();
  const [preview, setPreview] = useState<BoardRow | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();
  const [tagSaving, setTagSaving] = useState(false);
  const [tagError, setTagError] = useState<string | undefined>();
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichError, setEnrichError] = useState<string | undefined>();
  const [noteId, setNoteId] = useState<string | undefined>();
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | undefined>();

  const rowFor = useCallback(
    (trackId?: string) => (trackId ? rows.find((row) => row.trackId === trackId) : undefined),
    [rows],
  );
  const tagRow = rowFor(tagId);
  const enrichRow = rowFor(enrichId);
  const noteRow = rowFor(noteId);
  const pushRow = rowFor(push?.trackId);
  const pushPlatform = push
    ? (PLATFORMS.find((platform) => platform.key === push.platformKey) ?? null)
    : null;

  // A failed load-more shouldn't be swallowed; surface it next to mutation errors
  // and use it to pause the infinite-scroll observer until a manual retry.
  const loadError = queryError
    ? queryError instanceof Error
      ? queryError.message
      : String(queryError)
    : undefined;
  const shownError = error ?? loadError;

  // Each row carries its derived stage so the worklist filter reads the same
  // source as the lifecycle model. In-memory filtering is fine at current scale.
  const staged = useMemo(() => rows.map((row) => ({ ...trackStage(row), row })), [rows]);

  const worklistDef = WORKLISTS.find((worklist) => worklist.key === activeWorklist) ?? WORKLISTS[0];
  const visible = useMemo(
    () =>
      worklistDef.key === "all"
        ? staged
        : staged.filter((entry) => entry.blockedOn === worklistDef.blockedOn),
    [staged, worklistDef],
  );

  const counts = useMemo(() => {
    const byBlocked = new Map<BlockedOn, number>();
    for (const entry of staged) {
      byBlocked.set(entry.blockedOn, (byBlocked.get(entry.blockedOn) ?? 0) + 1);
    }
    return (worklist: (typeof WORKLISTS)[number]) =>
      worklist.key === "all" ? staged.length : (byBlocked.get(worklist.blockedOn ?? null) ?? 0);
  }, [staged]);

  // Advisory pending-draft count among loaded rows — surfaced inside the TikTok
  // push dialog (cap 5/24h), not in the header.
  const tiktokPending = useMemo(
    () =>
      rows.filter((row) =>
        row.posts.some((post) => post.platform === "tiktok" && post.status === "draft"),
      ).length,
    [rows],
  );

  const setWorklist = useCallback(
    (next: Worklist) => {
      void navigate({ search: (prev) => ({ ...prev, stage: next }) });
    },
    [navigate],
  );

  // Patch one row's own fields in the board cache (the publish hook patches posts;
  // this is for the track-level fields tagging + enrichment change).
  const patchRow = useCallback(
    (trackId: string, patch: Partial<BoardRow>) => {
      queryClient.setQueryData<InfiniteData<BoardPage, string | undefined>>(BOARD_KEY, (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                tracks: page.tracks.map((row) =>
                  row.trackId === trackId ? { ...row, ...patch } : row,
                ),
              })),
            }
          : current,
      );
    },
    [queryClient],
  );

  const markCopied = useCallback((id: string) => {
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((current) => (current === id ? undefined : current)), 1600);
  }, []);

  // Quick caption copy — lazily fetch the caption inside the tap and hand it to the
  // clipboard as a Promise, so the async read stays within the user gesture (iOS
  // rejects a write that lands after an awaited fetch).
  const copyCaption = useCallback(
    (row: BoardRow) => {
      if (!row.logId) {
        return;
      }

      setError(undefined);
      const text = fetchCaption({ data: { logId: row.logId } }).then(({ caption }) =>
        caption
          ? new Blob([caption], { type: "text/plain" })
          : Promise.reject(new Error("no caption")),
      );
      navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]).then(
        () => markCopied(row.trackId),
        () => setError("Couldn't copy the caption."),
      );
    },
    [markCopied, setError],
  );

  // The Spotify connection light — polled on focus so an expired authorization
  // (cleared server-side on invalid_grant) surfaces the moment the operator tabs
  // back. Reconnecting hands the browser to the gated auth-start, which returns the
  // Spotify authorize URL; the callback lands back on the board.
  const { data: spotifyStatus } = useQuery({
    queryFn: fetchSpotifyStatus,
    queryKey: SPOTIFY_STATUS_KEY,
    refetchOnWindowFocus: true,
  });

  const reconnectSpotify = useCallback(async () => {
    setError(undefined);

    try {
      const response = await fetch("/api/admin/spotify/auth/start", { credentials: "same-origin" });
      const data = (await response.json()) as { authUrl?: string };

      if (!response.ok || !data.authUrl) {
        throw new Error("Couldn't start the Spotify reconnect.");
      }

      window.location.href = data.authUrl;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [setError]);

  // The Tag dialog's map backdrop — fetched on first open, then cached.
  const { data: points = [] } = useQuery({
    enabled: tagId !== undefined,
    queryFn: fetchVibePoints,
    queryKey: POINTS_KEY,
    refetchOnWindowFocus: true,
  });

  // The next finding in the current worklist — powers "Save & next" in the Tag and
  // Note dialogs so a batch is one sitting. Undefined at the end of the list, which
  // closes the dialog.
  const nextVisibleTrackId = useCallback(
    (currentTrackId: string): string | undefined => {
      const index = visible.findIndex((entry) => entry.row.trackId === currentTrackId);
      return index >= 0 && index + 1 < visible.length ? visible[index + 1]?.row.trackId : undefined;
    },
    [visible],
  );

  const saveTag = useCallback(
    async (x: number, y: number, advance?: boolean) => {
      if (!tagRow) {
        return;
      }

      setTagSaving(true);
      setTagError(undefined);

      try {
        const response = await fetch(`/api/admin/tracks/${tagRow.trackId}`, {
          body: JSON.stringify({ vibeX: x, vibeY: y }),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });

        if (!response.ok) {
          throw new Error(`Save failed (${response.status})`);
        }

        const key = galaxyForVibe(x, y);
        patchRow(tagRow.trackId, { galaxy: { key, name: GALAXIES[key].name }, vibeX: x, vibeY: y });
        // Keep the tag-map cache in step so the Tag dialog's backdrop stays current.
        queryClient.setQueryData<VibePoint[]>(POINTS_KEY, (current = []) => [
          ...current.filter((point) => point.trackId !== tagRow.trackId),
          {
            artists: tagRow.artists,
            title: tagRow.title,
            trackId: tagRow.trackId,
            vibeX: x,
            vibeY: y,
          },
        ]);
        setTagId(advance ? nextVisibleTrackId(tagRow.trackId) : undefined);
      } catch (caught) {
        setTagError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setTagSaving(false);
      }
    },
    [nextVisibleTrackId, patchRow, queryClient, tagRow],
  );

  // Save the finding's note (the editorial "why" that feeds its log-page prose +
  // schema). Optimistically patches the row; "Save & next" walks the worklist.
  const saveNote = useCallback(
    async (note: string, advance?: boolean) => {
      if (!noteRow) {
        return;
      }

      setNoteSaving(true);
      setNoteError(undefined);

      try {
        const response = await fetch(`/api/admin/tracks/${noteRow.trackId}`, {
          body: JSON.stringify({ note }),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });

        if (!response.ok) {
          throw new Error(`Save failed (${response.status})`);
        }

        patchRow(noteRow.trackId, { note: note.trim() || undefined });
        setNoteId(advance ? nextVisibleTrackId(noteRow.trackId) : undefined);
      } catch (caught) {
        setNoteError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setNoteSaving(false);
      }
    },
    [nextVisibleTrackId, noteRow, patchRow],
  );

  // Re-place an already-placed neighbour from inside the Tag dialog (edit-in-place).
  // Same write as saveTag, but for any trackId, and it throws on failure so the
  // dialog can surface the error + keep the marker live. Optimistically refreshes
  // both the map backdrop (POINTS_KEY) and the board row if it's loaded.
  const savePoint = useCallback(
    async (trackId: string, x: number, y: number) => {
      const response = await fetch(`/api/admin/tracks/${trackId}`, {
        body: JSON.stringify({ vibeX: x, vibeY: y }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });

      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`);
      }

      const key = galaxyForVibe(x, y);
      patchRow(trackId, { galaxy: { key, name: GALAXIES[key].name }, vibeX: x, vibeY: y });
      queryClient.setQueryData<VibePoint[]>(POINTS_KEY, (current = []) =>
        current.map((point) =>
          point.trackId === trackId ? { ...point, vibeX: x, vibeY: y } : point,
        ),
      );
    },
    [patchRow, queryClient],
  );

  const runEnrichment = useCallback(async () => {
    if (!enrichRow?.logId) {
      return;
    }

    setEnrichBusy(true);
    setEnrichError(undefined);

    try {
      await triggerEnrichmentFn({ data: { logId: enrichRow.logId, trackId: enrichRow.trackId } });
      // Optimistic: a good enqueue marks the record "processing" server-side; show
      // it immediately. Window-focus refetch reconciles with the agent's result.
      patchRow(enrichRow.trackId, { enrichmentStatus: "processing" });
      setEnrichId(undefined);
    } catch (caught) {
      setEnrichError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEnrichBusy(false);
    }
  }, [enrichRow, patchRow]);

  const onPush = useCallback(() => {
    if (push) {
      void pushDraft(push.trackId, push.platformKey);
    }
  }, [push, pushDraft]);

  const markLive = useCallback(
    async (url: string) => {
      if (!push) {
        return;
      }
      await setStatus(push.trackId, push.platformKey, "published", url);
      setPush(undefined);
    },
    [push, setStatus],
  );

  const markFailed = useCallback(async () => {
    if (!push) {
      return;
    }
    await setStatus(push.trackId, push.platformKey, "failed");
    setPush(undefined);
  }, [push, setStatus]);

  // Infinite scroll: auto-load when the sentinel nears the viewport bottom; the
  // button stays as a manual fallback. After a load error, auto mode pauses until a
  // manual retry clears it.
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !hasNextPage || isFetchingNextPage || loadError) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { rootMargin: "320px" },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, loadError]);

  const subheader = (
    <>
      <SpotifyStatusBanner onReconnect={() => void reconnectSpotify()} status={spotifyStatus} />
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 sm:px-5">
        {WORKLISTS.map((worklist) => {
          const isActive = worklist.key === activeWorklist;

          return (
            <Button
              key={worklist.key}
              onClick={() => setWorklist(worklist.key)}
              size="sm"
              variant={isActive ? "secondary" : "ghost"}
            >
              {worklist.label}
              <Badge
                className={cn(
                  "ml-1 tabular-nums",
                  isActive ? "border-primary/40 bg-primary/10 text-primary" : "",
                )}
                variant={isActive ? "outline" : "secondary"}
              >
                {counts(worklist)}
              </Badge>
            </Button>
          );
        })}
      </div>
      {shownError ? (
        <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-5">
          {shownError}
        </p>
      ) : undefined}
    </>
  );

  return (
    <AdminShell
      current="board"
      subheader={subheader}
      subtitle={`${totalCount} findings`}
      title="Board"
    >
      {rows.length === 0 ? (
        <EmptyState body="Logged bangers will show up here." title="No findings yet" />
      ) : visible.length === 0 ? (
        <EmptyState
          body={`Every loaded finding is past “${worklistDef.label.toLowerCase()}”.`}
          title="Nothing in this worklist"
        />
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[64rem]">
            {/* Column header */}
            <div
              className={cn(
                GRID,
                "border-b border-border px-4 py-2 text-xs font-bold text-muted-foreground sm:px-5",
              )}
            >
              <span>Log ID</span>
              <span>Finding</span>
              <span className="flex items-center gap-1.5">
                <WaveformIcon className="size-3.5" weight="fill" />
                Enrich
              </span>
              <span className="flex items-center gap-1.5">
                <CrosshairIcon className="size-3.5" weight="bold" />
                Tag
              </span>
              {PUBLISH_PLATFORMS.map((platform) => (
                <span className="flex items-center gap-1.5" key={platform.key}>
                  <platform.Icon className="size-3.5" weight="fill" />
                  {platform.label}
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <NotePencilIcon className="size-3.5" weight="bold" />
                Note
              </span>
            </div>

            <ul className="m-0 list-none p-0">
              {visible.map(({ row }) => (
                <li
                  className={cn(
                    GRID,
                    "border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-primary/5 sm:px-5",
                  )}
                  key={row.trackId}
                >
                  <LogIdCell logId={row.logId} />
                  <FindingCell onPreview={() => setPreview(row)} row={row} />
                  <EnrichStageCell onOpen={() => setEnrichId(row.trackId)} row={row} />
                  <TagStageCell onOpen={() => setTagId(row.trackId)} row={row} />
                  {PUBLISH_PLATFORMS.map((platform) => (
                    <PublishStageCell
                      key={platform.key}
                      onOpen={() => setPush({ platformKey: platform.key, trackId: row.trackId })}
                      platform={platform}
                      row={row}
                    />
                  ))}
                  <NoteStageCell onOpen={() => setNoteId(row.trackId)} row={row} />
                </li>
              ))}
            </ul>

            {hasNextPage ? (
              <div className="border-t border-border p-3 text-center sm:p-4" ref={sentinelRef}>
                <Button
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                  size="sm"
                  variant="outline"
                >
                  {isFetchingNextPage ? (
                    <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                  ) : undefined}
                  {isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : undefined}
          </div>
        </div>
      )}

      <EnrichDialog
        error={enrichError}
        onOpenChange={(open) => !open && setEnrichId(undefined)}
        onTrigger={runEnrichment}
        row={enrichRow ?? null}
        triggering={enrichBusy}
      />

      <TagDialog
        error={tagError}
        hasNext={tagRow ? nextVisibleTrackId(tagRow.trackId) !== undefined : false}
        onOpenChange={(open) => !open && setTagId(undefined)}
        onSave={(x, y) => void saveTag(x, y)}
        onSaveAndNext={(x, y) => void saveTag(x, y, true)}
        onSavePoint={savePoint}
        points={points}
        row={tagRow ?? null}
        saving={tagSaving}
      />

      <NoteDialog
        error={noteError}
        hasNext={noteRow ? nextVisibleTrackId(noteRow.trackId) !== undefined : false}
        onOpenChange={(open) => !open && setNoteId(undefined)}
        onSave={(note) => void saveNote(note)}
        onSaveAndNext={(note) => void saveNote(note, true)}
        row={noteRow ?? null}
        saving={noteSaving}
      />

      <PushDialog
        busy={(status) =>
          push ? Boolean(busy[`${push.trackId}:${push.platformKey}:${status}`]) : false
        }
        copied={copiedId === pushRow?.trackId}
        onCopyCaption={() => pushRow && copyCaption(pushRow)}
        onMarkFailed={markFailed}
        onMarkLive={markLive}
        onOpenChange={(open) => !open && setPush(undefined)}
        onPush={onPush}
        platform={pushPlatform}
        pushing={push ? Boolean(busy[`${push.trackId}:${push.platformKey}:draft`]) : false}
        row={pushRow ?? null}
        tiktokPending={tiktokPending}
      />

      {/* Single-clip preview — the same Stories UI as /log/<id>, one post (no
          swipe). Loads the clip only on open; handy for lining up the TikTok sound. */}
      <Dialog onOpenChange={(open) => !open && setPreview(undefined)} open={preview !== undefined}>
        <DialogContent
          aria-label="Clip preview"
          className="inset-0 top-0 left-0 block h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-transparent p-0 ring-0 sm:max-w-none"
          showCloseButton={false}
        >
          {preview ? (
            <StoriesPlayer
              initialLogId={preview.logId ?? undefined}
              onClose={() => setPreview(undefined)}
              onStoryChange={() => {}}
              presentation="dialog"
              tracks={[preview]}
            />
          ) : undefined}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

// The Spotify connection banner — shown only when there's something to act on:
// disconnected (the stored authorization is gone, so search + publishing are
// paused) or stale (still working, but old enough to reconnect before the
// six-month expiry). A quiet strip under the header with one Reconnect action.
function SpotifyStatusBanner({
  onReconnect,
  status,
}: {
  onReconnect: () => void;
  status?: SpotifyAuthStatus;
}) {
  if (!status || (status.connected && !status.stale)) {
    return null;
  }

  const disconnected = !status.connected;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-sm sm:px-5",
        disconnected
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      <span>
        {disconnected
          ? "Spotify isn’t connected — search and publishing are paused until you reconnect."
          : `Spotify authorization is ${status.ageDays} days old and will expire — reconnect to avoid disruption.`}
      </span>
      <Button onClick={onReconnect} size="sm" variant={disconnected ? "destructive" : "secondary"}>
        Reconnect Spotify
      </Button>
    </div>
  );
}

function EmptyState({ body, title }: { body: string; title: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-20 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

// The finding's permanent identity (sector.orbit.mark), in its own scannable
// column. Quiet warm mono — Oxanium-family numerals carry the brand without
// spending the One Sun gold down the whole list.
function LogIdCell({ logId }: { logId?: string }) {
  return (
    <span className="truncate font-mono text-xs tracking-tight text-muted-foreground tabular-nums">
      {logId ?? ""}
    </span>
  );
}

// The finding: its cover (the only place rendering status lives — a clip wears the
// gold story-ring + play badge; no badge means no video) plus title + artists.
function FindingCell({ onPreview, row }: { onPreview: () => void; row: BoardRow }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {row.videoUrl ? (
        // Has a clip → the gold story-ring cue + play badge; opens a single-clip
        // preview. The One Sun gold, spent on the live artifact.
        <button
          aria-label={`Preview ${row.title} clip`}
          className="group relative size-11 shrink-0 rounded-md shadow-[0_0_14px_-3px_var(--eclipse-gold)] outline-none ring-2 ring-primary transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--eclipse-glow)] motion-reduce:transition-none"
          onClick={onPreview}
          title="Preview clip"
          type="button"
        >
          <img
            alt=""
            className="size-full rounded-md object-cover"
            src={row.albumImageUrl ?? "/fluncle-cover.png"}
          />
          <span
            aria-hidden="true"
            className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
          >
            <PlayIcon className="size-2.5" weight="fill" />
          </span>
        </button>
      ) : (
        <img
          alt=""
          className="size-11 shrink-0 rounded-md object-cover"
          src={row.albumImageUrl ?? "/fluncle-cover.png"}
        />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.title}</p>
        <p className="truncate text-xs text-muted-foreground">{row.artists.join(", ")}</p>
      </div>
    </div>
  );
}

function EnrichStageCell({ onOpen, row }: { onOpen: () => void; row: BoardRow }) {
  const status = row.enrichmentStatus;
  const state: StageState =
    status === "done" ? "done" : status === "processing" ? "running" : "open";
  // No detail line — the cell stays single-line (matching the others); the full
  // BPM + key live in the Enrich dialog.

  return (
    <StageCell
      icon={<WaveformIcon className="size-4" weight={state === "open" ? "regular" : "fill"} />}
      label={state === "done" ? "Enriched" : state === "running" ? "Enriching…" : "Enrich"}
      onClick={onOpen}
      state={state}
      title="Audio analysis on the Spinup agent"
    />
  );
}

function TagStageCell({ onOpen, row }: { onOpen: () => void; row: BoardRow }) {
  const tagged = row.vibeX !== undefined && row.vibeY !== undefined;
  const galaxy = row.galaxy?.key ?? (tagged ? galaxyForVibe(row.vibeX!, row.vibeY!) : undefined);

  return (
    <StageCell
      icon={
        galaxy ? (
          <span className="size-2.5 rounded-full" style={{ background: GALAXIES[galaxy].color }} />
        ) : (
          <CrosshairIcon className="size-4" weight="bold" />
        )
      }
      label={tagged ? (galaxy ? GALAXIES[galaxy].name : "Tagged") : "Tag"}
      onClick={onOpen}
      state={tagged ? "done" : "open"}
      title="Place on the vibe map"
    />
  );
}

// The note cell — optional, the last column. A note isn't a pipeline stage; it's
// the editorial "why" that feeds the finding's log-page prose + schema. The detail
// line shows a snippet of the note when one exists.
function NoteStageCell({ onOpen, row }: { onOpen: () => void; row: BoardRow }) {
  const note = row.note?.trim();

  return (
    <StageCell
      detail={note || undefined}
      icon={<NotePencilIcon className="size-4" weight={note ? "fill" : "regular"} />}
      label={note ? "Noted" : "Note"}
      onClick={onOpen}
      state={note ? "done" : "open"}
      title="The finding's note — shows on its log page"
    />
  );
}

function PublishStageCell({
  onOpen,
  platform,
  row,
}: {
  onOpen: () => void;
  platform: PlatformConfig;
  row: BoardRow;
}) {
  const post = row.posts.find((entry) => entry.platform === platform.key);
  const status = post?.status;
  // The live public URL is the last step of the circuit: YouTube auto-publishes but
  // records no URL, and TikTok is finished in-app — both land "published" with the
  // link still missing. That's a PARTIAL (open circuit, dashed), not done; only a
  // recorded URL closes the cell. Click the partial to paste the live URL.
  const hasLiveUrl = Boolean(post?.url);
  const state: StageState =
    status === "published"
      ? hasLiveUrl
        ? "done"
        : "partial"
      : status === "draft" || status === "scheduled"
        ? "partial"
        : "open";
  const label =
    status === "published"
      ? hasLiveUrl
        ? "Live"
        : "Add link"
      : status === "scheduled"
        ? "Scheduled"
        : status === "draft"
          ? "Drafted"
          : status === "failed"
            ? "Retry"
            : "Push";

  return (
    <StageCell
      detail={status === "failed" ? "push failed" : undefined}
      // Without a video there's nothing to push yet; the cell waits on the render.
      disabled={!row.videoUrl && !post}
      icon={<platform.Icon className="size-4" weight={state === "open" ? "regular" : "fill"} />}
      label={label}
      onClick={onOpen}
      state={state}
      title={!row.videoUrl && !post ? "No video yet — render first" : `${platform.label} publish`}
    />
  );
}
