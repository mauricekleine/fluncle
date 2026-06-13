import {
  ArrowSquareOutIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FilmSlateIcon,
  PaperPlaneTiltIcon,
  PlayIcon,
  TiktokLogoIcon,
  YoutubeLogoIcon,
} from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { StoriesPlayer } from "@/components/stories/stories-player";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trackMedia } from "@/lib/media";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { readCaptions } from "@/lib/server/captions";
import { listSocialPostsForTracks, type SocialPostItem } from "@/lib/server/social";
import { decodeTrackCursor, listTracks, type TrackListItem } from "@/lib/server/tracks";
import { cn } from "@/lib/utils";

// The admin posting board / content tracker: every finding newest-first, its
// per-platform social status + push controls, and a per-row Assets sheet (copy
// the caption, download the cuts/cover for AirDrop). The visual replacement for
// the `fluncle admin track draft|social` CLI, built to work one-handed on a
// phone. Reads + writes go through the same gated admin API the CLI uses.

const PAGE_SIZE = 50;

// Platforms shown as columns. `directPost` distinguishes the push shapes: TikTok
// pushes a private inbox DRAFT (the operator finishes in-app), YouTube posts
// DIRECTLY and publicly on click. Instagram is intentionally absent — there's no
// legitimate automated audio path (see docs/track-lifecycle.md Phase 3).
type PlatformConfig = {
  Icon: ComponentType<{ className?: string; weight?: "fill" | "bold" }>;
  directPost: boolean;
  key: string;
  label: string;
};

const PLATFORMS: PlatformConfig[] = [
  { Icon: TiktokLogoIcon, directPost: false, key: "tiktok", label: "TikTok" },
  { Icon: YoutubeLogoIcon, directPost: true, key: "youtube", label: "YouTube" },
];

type BadgeVariant = "default" | "secondary" | "outline" | "destructive";
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  draft: "secondary",
  failed: "destructive",
  published: "default",
  scheduled: "outline",
};

type BoardRow = TrackListItem & { posts: SocialPostItem[] };
type BoardPage = { nextCursor?: string; totalCount: number; tracks: BoardRow[] };

// Column template shared by the header + every row so they align. Each platform
// column is wide enough for its inner cell (below) so nothing overlaps; the
// table lives in a horizontal-scroll wrapper, so on a phone it scrolls sideways
// rather than cramming or wrapping.
const GRID = "grid grid-cols-[minmax(16rem,1fr)_14rem_14rem_auto] items-center gap-x-4";
// One platform cell: three fixed slots so status chips, primary buttons, and the
// overflow control each line up down the column (~13.5rem, fits the 14rem col).
const CELL = "grid grid-cols-[4.5rem_6.5rem_1.75rem] items-center gap-1.5";

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
    const posts = await listSocialPostsForTracks(page.tracks.map((track) => track.trackId));

    return {
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
      tracks: page.tracks.map((track) => ({ ...track, posts: posts[track.trackId] ?? [] })),
    };
  });

// Lazy caption read — only when the operator copies or opens a finding's Assets
// sheet, never preloaded for the whole page. Server-side (no CORS), reading the
// public note.txt (works in dev too — the binding is empty there).
const fetchCaption = createServerFn({ method: "GET" })
  .validator((data: { logId: string }) => data)
  .handler(async ({ data }): Promise<{ caption: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const captions = await readCaptions([data.logId]);

    return { caption: captions[data.logId] ?? "" };
  });

export const Route = createFileRoute("/admin/posts")({
  beforeLoad: async () => {
    await ensureAdmin();
  },
  component: AdminPostsPage,
  loader: async () => fetchBoard({ data: {} }),
});

type PublishTarget = {
  currentStatus?: string;
  platform: string;
  platformLabel: string;
  title: string;
  trackId: string;
};

function AdminPostsPage() {
  const initial = Route.useLoaderData();
  const [rows, setRows] = useState<BoardRow[]>(initial.tracks);
  const [nextCursor, setNextCursor] = useState<string | undefined>(initial.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | undefined>();
  const [publish, setPublish] = useState<PublishTarget | null>(null);
  const [publishUrl, setPublishUrl] = useState("");
  const [assets, setAssets] = useState<BoardRow | null>(null);
  const [preview, setPreview] = useState<BoardRow | null>(null);
  const [copiedId, setCopiedId] = useState<string | undefined>();

  const postFor = (row: BoardRow, platform: string) =>
    row.posts.find((post) => post.platform === platform);

  const markCopied = useCallback((id: string) => {
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((current) => (current === id ? undefined : current)), 1600);
  }, []);

  // Quick row copy — lazily fetch the caption inside the tap and hand it to the
  // clipboard as a Promise, so the async read stays within the user gesture (iOS
  // rejects a write that lands after an awaited fetch). No per-page preload.
  const copyRow = useCallback(
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
        () => setError("Couldn't copy — open Assets to copy the caption there."),
      );
    },
    [markCopied],
  );

  // Merge a platform post into a row after a successful mutation, so the board
  // reflects the new state without a full refetch.
  const applyPost = useCallback(
    (trackId: string, platform: string, patch: Partial<SocialPostItem>) => {
      const now = new Date().toISOString();

      setRows((current) =>
        current.map((row) => {
          if (row.trackId !== trackId) {
            return row;
          }

          const existing = row.posts.find((post) => post.platform === platform);
          const merged: SocialPostItem = existing
            ? { ...existing, ...patch, updatedAt: now }
            : { createdAt: now, platform, status: "draft", updatedAt: now, ...patch };

          return {
            ...row,
            posts: [...row.posts.filter((post) => post.platform !== platform), merged],
          };
        }),
      );
    },
    [],
  );

  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [key]: true }));
    setError(undefined);

    try {
      await fn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy((current) => ({ ...current, [key]: false }));
    }
  }, []);

  const pushDraft = useCallback(
    (row: BoardRow, platform: string) =>
      run(`${row.trackId}:${platform}:draft`, async () => {
        const response = await fetch(`/api/admin/tracks/${row.trackId}/social/${platform}/draft`, {
          credentials: "same-origin",
          method: "POST",
        });
        const data = (await response.json()) as {
          externalId?: string;
          message?: string;
          ok?: boolean;
          status?: string;
        };

        if (!response.ok || !data.ok) {
          throw new Error(data.message ?? `Push failed (${response.status})`);
        }

        applyPost(row.trackId, platform, {
          externalId: data.externalId,
          status: data.status ?? "draft",
        });
      }),
    [applyPost, run],
  );

  const setStatus = useCallback(
    (trackId: string, platform: string, status: string, url?: string) =>
      run(`${trackId}:${platform}:${status}`, async () => {
        const response = await fetch(`/api/admin/tracks/${trackId}/social/${platform}`, {
          body: JSON.stringify({ status, ...(url ? { url } : {}) }),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        const data = (await response.json()) as { message?: string; ok?: boolean };

        if (!response.ok || !data.ok) {
          throw new Error(data.message ?? `Update failed (${response.status})`);
        }

        applyPost(trackId, platform, { status, ...(url ? { url } : {}) });
      }),
    [applyPost, run],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) {
      return;
    }

    setLoadingMore(true);
    setError(undefined);

    try {
      const page = await fetchBoard({ data: { cursor: nextCursor } });
      setRows((current) => [...current, ...page.tracks]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  // Infinite scroll: auto-load when the sentinel nears the viewport bottom (the
  // home feed's pattern). The button stays as a manual fallback; after an error,
  // auto mode pauses until a manual retry clears it.
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !nextCursor || loadingMore || error) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { rootMargin: "320px" },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [error, loadingMore, loadMore, nextCursor]);

  const confirmPublish = useCallback(async () => {
    if (!publish) {
      return;
    }

    const url = publishUrl.trim();

    if (!url) {
      setError("A live post URL is required to mark it published.");
      return;
    }

    await setStatus(publish.trackId, publish.platform, "published", url);
    setPublish(null);
    setPublishUrl("");
  }, [publish, publishUrl, setStatus]);

  const confirmFail = useCallback(async () => {
    if (!publish) {
      return;
    }

    await setStatus(publish.trackId, publish.platform, "failed");
    setPublish(null);
    setPublishUrl("");
  }, [publish, setStatus]);

  // Advisory pending-draft count among loaded rows: TikTok caps unpublished inbox
  // drafts at 5 per rolling 24h, so this is a soft heads-up (we can't see in-app
  // clears), not exact.
  const tiktokDrafts = useMemo(
    () => rows.filter((row) => postFor(row, "tiktok")?.status === "draft").length,
    [rows],
  );

  const openManage = useCallback((row: BoardRow, platform: PlatformConfig) => {
    const current = postFor(row, platform.key);
    setPublish({
      currentStatus: current?.status,
      platform: platform.key,
      platformLabel: platform.label,
      title: row.title,
      trackId: row.trackId,
    });
    setPublishUrl(current?.url ?? "");
  }, []);

  const assetMedia = assets?.logId ? trackMedia(assets.logId) : undefined;
  const assetFiles = assetMedia
    ? [
        { label: "Video (with audio)", url: assetMedia.videoUrl },
        { label: "Silent video (TikTok cut)", url: assetMedia.silentVideoUrl },
        { label: "Cover", url: assetMedia.coverUrl },
        { label: "Poster", url: assetMedia.posterUrl },
        { label: "Caption (.txt)", url: assetMedia.noteUrl },
      ]
    : [];

  return (
    <main className="min-h-dvh p-3 text-foreground sm:p-4 lg:p-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card/80 outline outline-1 outline-border/40 outline-offset-4 backdrop-blur-xl">
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h1 className="text-sm font-bold">Posts</h1>
            <p className="text-xs text-muted-foreground">
              {initial.totalCount} findings · newest first
              {tiktokDrafts > 0 ? (
                <>
                  {" · "}
                  <span className={cn(tiktokDrafts >= 5 && "text-destructive")}>
                    {tiktokDrafts} TikTok draft{tiktokDrafts === 1 ? "" : "s"} pending
                  </span>{" "}
                  (cap 5/24h)
                </>
              ) : undefined}
            </p>
          </div>
          <AdminNav current="posts" />
        </header>

        {error ? (
          <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-5">
            {error}
          </p>
        ) : undefined}

        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 px-4 py-20 text-center">
            <p className="font-medium">No findings yet</p>
            <p className="text-sm text-muted-foreground">Logged bangers will show up here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[58rem]">
              {/* Column header */}
              <div
                className={cn(
                  GRID,
                  "border-b border-border px-5 py-2 text-xs font-bold text-muted-foreground",
                )}
              >
                <span>Finding</span>
                {PLATFORMS.map((platform) => (
                  <span className="flex items-center gap-1.5" key={platform.key}>
                    <platform.Icon className="size-3.5" weight="fill" />
                    {platform.label}
                  </span>
                ))}
                <span className="text-right">Assets</span>
              </div>

              <ul className="m-0 list-none p-0">
                {rows.map((row) => (
                  <li
                    className={cn(
                      GRID,
                      "border-b border-border px-5 py-3 transition-colors last:border-b-0 hover:bg-primary/5",
                    )}
                    key={row.trackId}
                  >
                    {/* Finding */}
                    <div className="flex min-w-0 items-center gap-3">
                      {row.videoUrl ? (
                        // Has a clip → the gold story-ring cue + play badge; opens
                        // a single-clip preview (loads only on open). One Sun gold.
                        <button
                          aria-label={`Preview ${row.title} clip`}
                          className="group relative size-11 shrink-0 rounded-md shadow-[0_0_14px_-3px_var(--eclipse-gold)] outline-none ring-2 ring-primary transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--eclipse-glow)]"
                          onClick={() => setPreview(row)}
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
                            <PlayIcon className="size-2.5 translate-x-px" weight="fill" />
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
                        <p className="truncate text-xs text-muted-foreground">
                          {row.artists.join(", ")}
                        </p>
                        <div className="mt-1 flex items-center gap-1.5">
                          {row.logId ? (
                            <Badge
                              className="font-mono text-[10px] tracking-tight tabular-nums"
                              variant="outline"
                            >
                              {row.logId}
                            </Badge>
                          ) : undefined}
                          {row.videoUrl ? (
                            <span
                              className="flex items-center gap-1 text-[10px] text-muted-foreground"
                              title={row.videoVehicle ?? "video ready"}
                            >
                              <FilmSlateIcon className="size-3" weight="fill" />
                              {row.videoVehicle ?? "video"}
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/70">no video</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Platform cells (grid columns 2–3) */}
                    {PLATFORMS.map((platform) => (
                      <PlatformCell
                        busy={busy}
                        key={platform.key}
                        onManage={() => openManage(row, platform)}
                        onPush={() => void pushDraft(row, platform.key)}
                        platform={platform}
                        post={postFor(row, platform.key)}
                        row={row}
                      />
                    ))}

                    {/* Assets + quick caption copy */}
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        disabled={!row.videoUrl}
                        onClick={() => copyRow(row)}
                        size="sm"
                        title={row.videoUrl ? "Copy the caption" : "No caption yet"}
                        variant="ghost"
                      >
                        {copiedId === row.trackId ? (
                          <CheckIcon aria-hidden="true" className="text-primary" weight="bold" />
                        ) : (
                          <CopyIcon aria-hidden="true" />
                        )}
                        <span className="sr-only">
                          {copiedId === row.trackId ? "Copied" : "Copy caption"}
                        </span>
                      </Button>
                      <Button
                        disabled={!row.videoUrl}
                        onClick={() => setAssets(row)}
                        size="sm"
                        title={row.videoUrl ? "Open caption + downloads" : "No assets yet"}
                        variant="outline"
                      >
                        <DownloadSimpleIcon aria-hidden="true" />
                        Assets
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>

              {nextCursor ? (
                <div className="border-t border-border p-3 text-center sm:p-4" ref={sentinelRef}>
                  <Button
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                    size="sm"
                    variant="outline"
                  >
                    {loadingMore ? (
                      <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                    ) : undefined}
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : undefined}
            </div>
          </div>
        )}
      </div>

      {/* Update-status dialog (mark published with URL / mark failed) */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPublish(null);
          }
        }}
        open={publish !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update {publish?.platformLabel} status</DialogTitle>
            <DialogDescription>
              Record where “{publish?.title}” landed on {publish?.platformLabel}. Mark it published
              with the live URL (lights up the link on the finding’s public row), or mark the push
              failed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="publish-url">Live post URL</Label>
            <Input
              autoFocus
              id="publish-url"
              onChange={(event) => setPublishUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void confirmPublish();
                }
              }}
              placeholder="https://www.tiktok.com/@fluncle/video/…"
              value={publishUrl}
            />
          </div>
          <DialogFooter className="sm:justify-between" showCloseButton>
            <Button
              disabled={
                publish?.currentStatus === "failed" ||
                (publish ? busy[`${publish.trackId}:${publish.platform}:failed`] : false)
              }
              onClick={() => void confirmFail()}
              variant="ghost"
            >
              Mark failed
            </Button>
            <Button
              disabled={
                !publishUrl.trim() ||
                (publish ? busy[`${publish.trackId}:${publish.platform}:published`] : false)
              }
              onClick={() => void confirmPublish()}
            >
              Mark published
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assets sheet — caption copy + downloadable bundle files (AirDrop-friendly) */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setAssets(null);
          }
        }}
        open={assets !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assets — {assets?.title}</DialogTitle>
            <DialogDescription>
              Copy the caption, or open any file to save / AirDrop it from your phone.
            </DialogDescription>
          </DialogHeader>

          <Button onClick={() => assets && copyRow(assets)} variant="outline">
            {copiedId === assets?.trackId ? (
              <CheckIcon aria-hidden="true" className="text-primary" weight="bold" />
            ) : (
              <CopyIcon aria-hidden="true" />
            )}
            {copiedId === assets?.trackId ? "Copied" : "Copy caption"}
          </Button>

          <div className="flex flex-col gap-1.5">
            <Label>Files</Label>
            {assetFiles.map((file) => (
              <Button
                className="justify-between"
                key={file.label}
                nativeButton={false}
                render={<a download href={file.url} rel="noreferrer" target="_blank" />}
                variant="ghost"
              >
                {file.label}
                <ArrowSquareOutIcon aria-hidden="true" />
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Single-clip preview — the same Stories UI as /log/<id>, but one post
          (no swipe). Loads the clip only when opened; a no-op onStoryChange
          keeps the admin URL put. Handy for lining up the TikTok sound. */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
          }
        }}
        open={preview !== null}
      >
        <DialogContent
          aria-label="Clip preview"
          className="inset-0 top-0 left-0 block h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-transparent p-0 ring-0 sm:max-w-none"
          showCloseButton={false}
        >
          {preview ? (
            <StoriesPlayer
              initialLogId={preview.logId ?? undefined}
              onClose={() => setPreview(null)}
              onStoryChange={() => {}}
              presentation="dialog"
              tracks={[preview]}
            />
          ) : undefined}
        </DialogContent>
      </Dialog>
    </main>
  );
}

type PlatformCellProps = {
  busy: Record<string, boolean>;
  onManage: () => void;
  onPush: () => void;
  platform: PlatformConfig;
  post?: SocialPostItem;
  row: BoardRow;
};

// Published is the success peak, but a solid-gold badge repeated down a column
// over-spends the One Sun gold (DESIGN) — so live reads as a soft gold tint.
function StatusChip({ status }: { status: string }) {
  if (status === "published") {
    return (
      <Badge className="border-primary/40 bg-primary/10 text-primary" variant="outline">
        live
      </Badge>
    );
  }

  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{status}</Badge>;
}

function PlatformCell({ busy, onManage, onPush, platform, post, row }: PlatformCellProps) {
  const pushing = busy[`${row.trackId}:${platform.key}:draft`];
  const isLive = post?.status === "published";
  // TikTok "pushes" a private draft; YouTube "posts" publicly on click.
  const verb = platform.directPost ? (post ? "Re-post" : "Post") : post ? "Re-push" : "Push";
  const pushTitle = !row.videoUrl
    ? "No video yet — render + upload first"
    : platform.directPost
      ? `Posts publicly to ${platform.label} now`
      : undefined;

  return (
    <div className={CELL}>
      <div className="min-w-0">
        {post ? (
          <StatusChip status={post.status} />
        ) : (
          <span className="whitespace-nowrap text-xs text-muted-foreground/50">not pushed</span>
        )}
      </div>

      <div>
        {isLive ? (
          post?.url ? (
            <Button
              nativeButton={false}
              render={<a href={post.url} rel="noreferrer" target="_blank" />}
              size="sm"
              variant="outline"
            >
              <ArrowSquareOutIcon aria-hidden="true" />
              View
            </Button>
          ) : undefined
        ) : (
          <Button
            disabled={!row.videoUrl || pushing}
            onClick={onPush}
            size="sm"
            title={pushTitle}
            variant="outline"
          >
            {pushing ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : (
              <PaperPlaneTiltIcon aria-hidden="true" weight="fill" />
            )}
            {verb}
          </Button>
        )}
      </div>

      <div>
        {post ? (
          <Button
            aria-label={`Update ${platform.label} status`}
            onClick={onManage}
            size="icon-sm"
            title={`Update ${platform.label} status`}
            variant="ghost"
          >
            <DotsThreeIcon aria-hidden="true" weight="bold" />
          </Button>
        ) : undefined}
      </div>
    </div>
  );
}
