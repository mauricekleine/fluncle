import {
  ArrowCounterClockwiseIcon,
  CassetteTapeIcon,
  CircleNotchIcon,
  ClockCountdownIcon,
  EnvelopeSimpleIcon,
  FilmSlateIcon,
  ImageIcon,
  MicrophoneStageIcon,
  PaperPlaneTiltIcon,
  ProhibitIcon,
  QuotesIcon,
  TagIcon,
  TrayIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { AdminShell } from "@/components/admin/admin-shell";
import { usePublish } from "@/components/admin/use-publish";
import { InstagramIcon, MixcloudIcon, TiktokIcon, YoutubeIcon } from "@/components/platform-icons";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@fluncle/ui/components/popover";
import {
  type AttentionItem,
  type AttentionSource,
  deadlineReadout,
  formatAge,
  orderQueue,
  type PrimaryAction,
  primaryFor,
  snoozeReadout,
  snoozeSlots,
} from "@/lib/attention";
import {
  dismissRow,
  pruneQueuePrefs,
  restoreRow,
  snoozeRow,
  useQueuePrefs,
} from "@/lib/queue-prefs";
import { trackMedia } from "@/lib/media";
import { type Platform } from "@/lib/platforms";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { readAttentionSnapshot } from "@/lib/server/attention";
import { readCaptions } from "@/lib/server/captions";
import { captionForPlatform } from "@/lib/server/mentions";
import { cn } from "@/lib/utils";

// The operator's `/admin` home — the attention queue. Every action the system
// needs is a row: cover art, the object
// line, its data, and the primary action inline (or a deep-link with the object
// selected). Two-tier order (deadlines by time-left, then oldest-first), a
// bounded working set, snooze / won't-do, a single-key loop (j/k + Enter), and a
// zero state that celebrates. Zero rows is the success state.
//
// The pure mechanics live in lib/attention.ts; the server reads in
// lib/server/attention.ts; the snooze/won't-do map in lib/queue-prefs.ts
// (localStorage — one operator, one browser; a server column couldn't see this
// browser's snoozes). The findings board this page replaced lives at
// /admin/findings; its old ?stage/?mix deep-links redirect there.

const QUEUE_KEY = ["admin", "attention"] as const;

// A scratch react-query key for `usePublish` on this page. The hook patches its
// board cache after a push; the queue has no board query, so we point it at an
// unused key (the patch no-ops on the absent cache) and instead invalidate
// QUEUE_KEY ourselves so the row re-derives from the server.
const DISTRIBUTE_KEY = ["admin", "attention-distribute"] as const;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// Every admin server function re-checks the grant — the page guard only protects
// the render, not the RPC behind a server function.
const fetchAttention = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return readAttentionSnapshot();
});

// Lazy caption read for [Copy caption] — reads the public note.txt server-side
// inside the tap (the board's gesture-safe clipboard pattern).
const fetchCaption = createServerFn({ method: "GET" })
  .validator((data: { logId: string; trackId?: string }) => data)
  .handler(async ({ data }): Promise<{ caption: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const captions = await readCaptions([data.logId]);
    const raw = captions[data.logId] ?? "";

    // The copied caption is the operator's manual TikTok paste (YouTube auto-pushes with
    // its own handles), so it carries the finding's TikTok @handles at copy time.
    return { caption: await captionForPlatform(data.trackId ?? "", "tiktok", raw) };
  });

type QueueSearch = {
  /** The [Show all] view state — deep-linked so the widened view survives reload. */
  all?: true;
  /** Legacy board search params — redirected to /admin/findings in beforeLoad. */
  mix?: string;
  stage?: string;
};

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/")({
  validateSearch: (search: Record<string, unknown>): QueueSearch => ({
    ...(search.all === true || search.all === "1" || search.all === 1
      ? { all: true as const }
      : {}),
    ...(typeof search.mix === "string" ? { mix: search.mix } : {}),
    ...(typeof search.stage === "string" ? { stage: search.stage } : {}),
  }),
  beforeLoad: async ({ search }) => {
    // The findings board owned `/admin` before the queue; its ?stage/?mix
    // deep-links (bookmarks) land here and carry straight over.
    if (search.stage !== undefined || search.mix !== undefined) {
      const params = new URLSearchParams();
      if (search.stage !== undefined) {
        params.set("stage", search.stage);
      }
      if (search.mix !== undefined) {
        params.set("mix", search.mix);
      }
      throw redirect({ href: `/admin/findings?${params.toString()}` });
    }
    await ensureAdmin();
  },
  loader: async () => ({ snapshot: await fetchAttention() }),
  component: AdminQueuePage,
});

/** Where a visible row sits — due rows count toward zero, the rest ride [Show all]. */
type RowState = "backlog" | "dismissed" | "due" | "snoozed";

type VisibleRow = { item: AttentionItem; state: RowState };

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Trigger a file download for a URL without navigating away (the push dialog's
// "Download cover" gesture, expressed programmatically for the row menu).
function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noreferrer";
  anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// Render the cover to a PNG blob (the one image type browsers reliably accept on
// the clipboard). Needs the object to be CORS-readable; a taint or load failure
// throws, and the caller falls back to a download.
async function coverToPngBlob(url: string): Promise<Blob> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.crossOrigin = "anonymous";
    element.addEventListener("load", () => resolve(element));
    element.addEventListener("error", () => reject(new Error("cover load failed")));
    element.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("no 2d context");
  }
  context.drawImage(image, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    throw new Error("cover encode failed");
  }
  return blob;
}

// Grab the cover for pasting/attaching into the target app: copy the image to the
// clipboard when the browser + CORS allow it, otherwise fall back to a download
// (matching the push dialog's "Download cover"). Never rejects — the download
// path always resolves.
async function copyOrDownloadCover(
  url: string,
  filename: string,
): Promise<"copied" | "downloaded"> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const png = await coverToPngBlob(url);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return "copied";
    } catch {
      // Fall through to the download path below.
    }
  }
  downloadUrl(url, filename);
  return "downloaded";
}

function AdminQueuePage() {
  const { snapshot: initial } = Route.useLoaderData();
  const { all: showAll = false } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  // The board's publish engine, reused verbatim for the row's push actions — the
  // same gated `/social/:platform/draft` op the board push dialog calls. Its cache
  // patch targets DISTRIBUTE_KEY (an unused scratch key), so we invalidate the
  // queue ourselves after each push (below) to re-derive the row.
  const {
    busy: pushBusy,
    error: pushError,
    pushDraft,
    setError: setPushError,
  } = usePublish(DISTRIBUTE_KEY);

  // Seeded from the SSR loader; window-focus refetch keeps the rows honest when
  // the operator tabs back from TikTok / the Studio / a terminal.
  const { data, error: queryError } = useQuery({
    initialData: initial,
    queryFn: () => fetchAttention(),
    queryKey: QUEUE_KEY,
    refetchOnWindowFocus: true,
  });

  const prefs = useQueuePrefs();

  // The queue's clock — ages and deadlines tick while the tab sits open (30s is
  // honest for minute-grade readouts; tabular numerals keep the update quiet).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Rows cleared optimistically this session (marked posted) — removed locally the
  // moment the op lands; the next refetch reconciles with the server.
  const [clearedIds, setClearedIds] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(
    () => data.items.filter((item) => !clearedIds.has(item.id)),
    [clearedIds, data.items],
  );

  // Prune decisions for rows that left the system, so the stored map stays
  // bounded to what actually exists.
  useEffect(() => {
    pruneQueuePrefs(new Set(data.items.map((item) => item.id)));
  }, [data.items]);

  // Surface a failed push (the hook swallows it into state) as a toast, then clear
  // it so the same error can fire again on a retry.
  useEffect(() => {
    if (pushError) {
      toast.error(pushError);
      setPushError(undefined);
    }
  }, [pushError, setPushError]);

  const ordered = useMemo(() => orderQueue(items, prefs, now), [items, now, prefs]);

  const visible = useMemo<VisibleRow[]>(() => {
    const rows: VisibleRow[] = ordered.due.map((item) => ({ item, state: "due" as const }));
    if (showAll) {
      rows.push(
        ...ordered.backlog.map((item) => ({ item, state: "backlog" as const })),
        ...ordered.snoozed.map((item) => ({ item, state: "snoozed" as const })),
        ...ordered.dismissed.map((item) => ({ item, state: "dismissed" as const })),
      );
    }
    return rows;
  }, [ordered, showAll]);

  // The latest visible list for callbacks that outlive a render (the 200ms settle).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // The keyboard cursor. Selection follows the row's identity; when its row
  // leaves, the explicit advance (below) hands the cursor to the neighbour.
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const selectedIndex = Math.max(
    0,
    visible.findIndex((row) => row.item.id === selectedId),
  );
  const selectedRow = visible[selectedIndex];

  const primaryRefs = useRef(new Map<string, HTMLElement>());
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const registerPrimary = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      primaryRefs.current.set(id, el);
    } else {
      primaryRefs.current.delete(id);
    }
  }, []);

  const registerRow = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) {
      rowRefs.current.set(id, el);
    } else {
      rowRefs.current.delete(id);
    }
  }, []);

  const advanceFrom = useCallback((id: string) => {
    const rows = visibleRef.current;
    const index = rows.findIndex((row) => row.item.id === id);
    const next = rows[index + 1] ?? rows[index - 1];
    setSelectedId(next?.item.id);
  }, []);

  // ── Action state ────────────────────────────────────────────────────────────
  const [busyId, setBusyId] = useState<string | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();
  const [flashId, setFlashId] = useState<string | undefined>();
  const [leavingId, setLeavingId] = useState<string | undefined>();
  const [snoozeFor, setSnoozeFor] = useState<string | undefined>();
  // The open "Mark posted" popover — a TikTok draft's finish-in-app panel (copy the cover,
  // paste the live URL). Per-row; the URL field lives inside the popover, so one row's edit
  // can't leak into another's (the old page-level markUrl leaked the previous track's URL).
  const [finishFor, setFinishFor] = useState<string | undefined>();
  // The zero state's cover — the last row dealt with this session; a fresh load
  // falls back to the newest finding's cover from the snapshot.
  const [lastCleared, setLastCleared] = useState<{ artUrl?: string } | undefined>();

  // The tactile action-fire + settle-out: a gold flash while the row fades, then
  // the state change lands (200ms, ease-out). Reduced motion: the change is
  // instant — no flash, no fade.
  const settleOut = useCallback(
    (item: AttentionItem, finish: () => void) => {
      setLastCleared(item.artUrl ? { artUrl: item.artUrl } : {});
      const done = () => {
        advanceFrom(item.id);
        finish();
        setLeavingId((current) => (current === item.id ? undefined : current));
      };
      if (prefersReducedMotion()) {
        done();
        return;
      }
      setLeavingId(item.id);
      window.setTimeout(done, 220);
    },
    [advanceFrom],
  );

  const handleSnooze = useCallback(
    (item: AttentionItem, until: string) => {
      setSnoozeFor(undefined);
      settleOut(item, () => snoozeRow(item.id, until));
    },
    [settleOut],
  );

  const handleWontDo = useCallback(
    (item: AttentionItem) => {
      settleOut(item, () => {
        dismissRow(item.id);
        toast("Won't do", {
          action: { label: "Undo", onClick: () => restoreRow(item.id) },
          description: item.title,
        });
      });
    },
    [settleOut],
  );

  const handleRestore = useCallback((item: AttentionItem) => {
    restoreRow(item.id);
    setSelectedId(item.id);
  }, []);

  // Quick caption copy — the caption is fetched inside the tap and handed to the
  // clipboard as a Promise, so the async read stays within the user gesture (iOS
  // rejects a write that lands after an awaited fetch). Copying auto-advances the
  // cursor: the loop keeps moving.
  const copyCaption = useCallback(
    (item: AttentionItem) => {
      if (!item.logId) {
        return;
      }
      const logId = item.logId;
      const text = fetchCaption({ data: { logId, trackId: item.trackId } }).then(({ caption }) =>
        caption
          ? new Blob([caption], { type: "text/plain" })
          : Promise.reject(new Error("no caption")),
      );
      navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]).then(
        () => {
          setCopiedId(item.id);
          window.setTimeout(
            () => setCopiedId((current) => (current === item.id ? undefined : current)),
            1600,
          );
          advanceFrom(item.id);
        },
        () => toast.error("Couldn't copy the caption."),
      );
    },
    [advanceFrom],
  );

  // Re-push a bounced draft — the same gated op the board's push dialog calls.
  // The row stays: its deadline resets to a fresh 24h on the refetch.
  const rePush = useCallback(
    async (item: AttentionItem) => {
      if (!item.trackId || busyId) {
        return;
      }
      setBusyId(item.id);
      try {
        const response = await fetch(`/api/admin/tracks/${item.trackId}/social/tiktok/draft`, {
          credentials: "same-origin",
          method: "POST",
        });
        const result = (await response.json()) as { message?: string; ok?: boolean };
        if (!response.ok || !result.ok) {
          throw new Error(result.message ?? `Push failed (${response.status})`);
        }
        setFlashId(item.id);
        window.setTimeout(
          () => setFlashId((current) => (current === item.id ? undefined : current)),
          400,
        );
        void queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyId(undefined);
      }
    },
    [busyId, queryClient],
  );

  // Record the hand-finished TikTok post — `update_track_social` with the real
  // public URL (published requires one). The row clears; refetch reconciles.
  const markPosted = useCallback(
    async (item: AttentionItem, url: string) => {
      if (!item.trackId || busyId) {
        return;
      }
      setBusyId(item.id);
      try {
        const response = await fetch(`/api/admin/tracks/${item.trackId}/social/tiktok`, {
          body: JSON.stringify({ status: "published", url }),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        const result = (await response.json()) as { message?: string; ok?: boolean };
        if (!response.ok || !result.ok) {
          throw new Error(result.message ?? `Update failed (${response.status})`);
        }
        setFinishFor(undefined);
        settleOut(item, () => {
          setClearedIds((current) => new Set(current).add(item.id));
          void queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
        });
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyId(undefined);
      }
    },
    [busyId, queryClient, settleOut],
  );

  // Push the finding's video to a platform straight from the row — the same gated
  // draft op as the board (YouTube posts a public Short; TikTok drops a silent
  // inbox draft). Reconcile the queue afterwards: a fresh TikTok push becomes this
  // finding's deadline row, a YouTube push leaves the TikTok-tracked row as-is.
  const handlePush = useCallback(
    async (item: AttentionItem, platform: Platform) => {
      if (!item.trackId) {
        return;
      }
      await pushDraft(item.trackId, platform);
      void queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
    },
    [pushDraft, queryClient],
  );

  // Grab the cover to paste/attach into the app — clipboard when the browser
  // allows it, a download otherwise (the push dialog's cover gesture).
  const copyCover = useCallback((item: AttentionItem) => {
    if (!item.logId) {
      return;
    }
    const { coverUrl } = trackMedia(item.logId);
    void copyOrDownloadCover(coverUrl, `${item.logId}-cover.jpg`).then((mode) => {
      toast(mode === "copied" ? "Cover copied to the clipboard" : "Cover downloaded");
    });
  }, []);

  // ── The single-key loop ─────────────────────────────────────────────────────
  // j/k (or arrows) move the cursor, Enter fires the selected row's primary, s
  // snoozes, x won't-does. Inert while a popover owns the keys or focus sits in a
  // field; Enter defers to whatever control actually has focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (snoozeFor !== undefined || finishFor !== undefined) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName)) {
          return;
        }
        if (event.key === "Enter" && target.closest("button, a")) {
          return;
        }
      }
      const rows = visibleRef.current;
      if (rows.length === 0) {
        return;
      }
      const index = Math.max(
        0,
        rows.findIndex((row) => row.item.id === selectedId),
      );
      const current = rows[index];
      switch (event.key) {
        case "ArrowDown":
        case "j": {
          event.preventDefault();
          const next = rows[Math.min(index + 1, rows.length - 1)];
          setSelectedId(next?.item.id);
          break;
        }
        case "ArrowUp":
        case "k": {
          event.preventDefault();
          const previous = rows[Math.max(index - 1, 0)];
          setSelectedId(previous?.item.id);
          break;
        }
        case "Enter": {
          if (current) {
            event.preventDefault();
            primaryRefs.current.get(current.item.id)?.click();
          }
          break;
        }
        case "s": {
          if (current && current.state !== "dismissed") {
            event.preventDefault();
            setSelectedId(current.item.id);
            setSnoozeFor(current.item.id);
          }
          break;
        }
        case "x": {
          if (current && current.state !== "dismissed") {
            event.preventDefault();
            setSelectedId(current.item.id);
            handleWontDo(current.item);
          }
          break;
        }
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finishFor, handleWontDo, selectedId, snoozeFor]);

  // Keep the cursor's row on screen as j/k walk past the fold.
  useEffect(() => {
    if (selectedId) {
      rowRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedId]);

  const toggleShowAll = useCallback(() => {
    void navigate({
      search: (previous) => ({ ...previous, all: showAll ? undefined : (true as const) }),
    });
  }, [navigate, showAll]);

  const activeCount = ordered.due.length + ordered.backlog.length;
  const hiddenCount = showAll
    ? 0
    : ordered.backlog.length + ordered.snoozed.length + ordered.dismissed.length;
  const allCount = items.length;

  const subtitleParts: string[] = [];
  if (activeCount > 0) {
    subtitleParts.push(`${activeCount} waiting`);
  }
  if (data.renderQueueDepth > 0) {
    subtitleParts.push(`render queue ${data.renderQueueDepth}`);
  }
  // tabular-nums: the counts tick on refetch and must not jitter (The Tabular Rule).
  const subtitle =
    subtitleParts.length > 0 ? (
      <span className="tabular-nums">{subtitleParts.join(" · ")}</span>
    ) : undefined;

  const loadError = queryError
    ? queryError instanceof Error
      ? queryError.message
      : String(queryError)
    : undefined;

  const showZero = ordered.due.length === 0 && ordered.backlog.length === 0 && !showAll;
  const zeroCover = lastCleared?.artUrl ?? data.latestCoverUrl;

  const subheader =
    visible.length > 0 || hiddenCount > 0 || showAll || loadError ? (
      <>
        <div className="flex min-h-10 items-center justify-between gap-2 border-b border-border px-3 py-1.5 sm:px-4">
          {hiddenCount > 0 || showAll ? (
            <Button onClick={toggleShowAll} size="sm" variant="ghost">
              {showAll ? "Show less" : "Show all"}
              <Badge className="tabular-nums" variant="secondary">
                {showAll ? allCount : hiddenCount + ordered.due.length}
              </Badge>
            </Button>
          ) : (
            <span />
          )}
          {visible.length > 0 ? <KeyLegend /> : undefined}
        </div>
        {loadError ? (
          <p className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:px-4">
            {loadError}
          </p>
        ) : undefined}
      </>
    ) : undefined;

  return (
    <AdminShell subheader={subheader} subtitle={subtitle} title="Dashboard">
      {showZero ? (
        <ZeroState coverUrl={zeroCover} />
      ) : (
        <ul aria-label="Attention queue" className="flex flex-col">
          {visible.map((row) => (
            <QueueRow
              busy={busyId === row.item.id}
              copied={copiedId === row.item.id}
              flash={flashId === row.item.id}
              key={row.item.id}
              item={row.item}
              leaving={leavingId === row.item.id}
              finishOpen={finishFor === row.item.id}
              now={now}
              onCopyCaption={copyCaption}
              onCopyCover={copyCover}
              onFinishOpenChange={(open) => setFinishFor(open ? row.item.id : undefined)}
              onMarkPosted={markPosted}
              onPush={handlePush}
              onRePush={rePush}
              onRestore={handleRestore}
              onSelect={setSelectedId}
              onSnooze={handleSnooze}
              onSnoozeOpenChange={(open) => setSnoozeFor(open ? row.item.id : undefined)}
              onWontDo={handleWontDo}
              pushBusy={pushBusy}
              registerPrimary={registerPrimary}
              registerRow={registerRow}
              selected={selectedRow?.item.id === row.item.id}
              snoozeOpen={snoozeFor === row.item.id}
              snoozedUntil={prefs[row.item.id]?.snoozedUntil}
              state={row.state}
            />
          ))}
        </ul>
      )}
    </AdminShell>
  );
}

// ─── One row ──────────────────────────────────────────────────────────────────

const SOURCE_ICONS: Record<AttentionSource, ComponentType<{ className?: string }>> = {
  "artist-review": MicrophoneStageIcon,
  "attach-cues": FilmSlateIcon,
  "capture-suspect": WaveformIcon,
  distribute: CassetteTapeIcon,
  "drip-empty": InstagramIcon,
  "label-review": TagIcon,
  newsletter: EnvelopeSimpleIcon,
  "note-rejected": QuotesIcon,
  "observation-rejected": MicrophoneStageIcon,
  "post-tiktok": TiktokIcon,
  "post-youtube": YoutubeIcon,
  submission: TrayIcon,
  "tiktok-draft": TiktokIcon,
};

// The glyph's text equivalent — the row's source, spoken (the glyph itself is
// decorative, so a screen reader still hears which platform/task the row is).
const SOURCE_LABELS: Record<AttentionSource, string> = {
  "artist-review": "Artist",
  "attach-cues": "Recording",
  "capture-suspect": "Capture check",
  distribute: "Mixtape",
  "drip-empty": "Instagram drip",
  "label-review": "Label",
  newsletter: "Newsletter",
  "note-rejected": "Held note",
  "observation-rejected": "Held observation",
  "post-tiktok": "TikTok",
  "post-youtube": "YouTube",
  submission: "Submission",
  "tiktok-draft": "TikTok draft",
};

type QueueRowProps = {
  busy: boolean;
  copied: boolean;
  finishOpen: boolean;
  flash: boolean;
  item: AttentionItem;
  leaving: boolean;
  now: number;
  onCopyCaption: (item: AttentionItem) => void;
  onCopyCover: (item: AttentionItem) => void;
  onFinishOpenChange: (open: boolean) => void;
  onMarkPosted: (item: AttentionItem, url: string) => void;
  onPush: (item: AttentionItem, platform: Platform) => void;
  onRePush: (item: AttentionItem) => void;
  onRestore: (item: AttentionItem) => void;
  onSelect: (id: string) => void;
  onSnooze: (item: AttentionItem, until: string) => void;
  onSnoozeOpenChange: (open: boolean) => void;
  onWontDo: (item: AttentionItem) => void;
  /** The publish hook's busy map, keyed `${trackId}:${platform}:${status}`. */
  pushBusy: Record<string, boolean>;
  registerPrimary: (id: string, el: HTMLElement | null) => void;
  registerRow: (id: string, el: HTMLLIElement | null) => void;
  selected: boolean;
  snoozeOpen: boolean;
  snoozedUntil?: string;
  state: RowState;
};

function QueueRow({
  busy,
  copied,
  finishOpen,
  flash,
  item,
  leaving,
  now,
  onCopyCaption,
  onCopyCover,
  onFinishOpenChange,
  onMarkPosted,
  onPush,
  onRePush,
  onRestore,
  onSelect,
  onSnooze,
  onSnoozeOpenChange,
  onWontDo,
  pushBusy,
  registerPrimary,
  registerRow,
  selected,
  snoozeOpen,
  snoozedUntil,
  state,
}: QueueRowProps) {
  const SourceIcon = SOURCE_ICONS[item.source];
  const primary = primaryFor(item, now);
  const deadline = item.deadlineAt ? deadlineReadout(item.deadlineAt, now) : undefined;
  // A fresh post row's primary pushes one platform; reflect that platform's in-flight state.
  const pushPlatform: Platform | undefined =
    item.source === "post-youtube"
      ? "youtube"
      : item.source === "post-tiktok"
        ? "tiktok"
        : undefined;
  const pushing =
    pushPlatform && item.trackId
      ? Boolean(pushBusy[`${item.trackId}:${pushPlatform}:draft`])
      : false;
  // A pushed TikTok draft is finished in-app, then marked posted here (copy the cover, paste
  // the live URL). Only tiktok-draft rows carry that panel.
  const canFinish = item.source === "tiktok-draft";
  const parked = state === "snoozed" || state === "dismissed";

  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-3 py-2.5 transition-[opacity,background-color] duration-200 ease-out last:border-0 sm:px-4",
        selected ? "bg-primary/10" : "hover:bg-primary/5",
        flash && "bg-primary/15",
        // 75%, not lower: the 11px Stardust meta must hold WCAG AA on the plate
        // (The Legible Sky Rule) — the row still carries a live Restore control.
        state === "dismissed" && "opacity-75",
        leaving && "pointer-events-none bg-primary/15 opacity-0",
      )}
      onClick={() => onSelect(item.id)}
      ref={(el) => registerRow(item.id, el)}
    >
      <RowArt artUrl={item.artUrl} Icon={SourceIcon} />

      <div className="min-w-0 flex-1 basis-44">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-bold">{item.title}</span>
          {item.logId ? (
            <span className="shrink-0 font-display text-xs tracking-[-0.01em] tabular-nums text-muted-foreground">
              {item.logId}
            </span>
          ) : undefined}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <SourceIcon aria-hidden="true" className="size-3" />
          <span className="sr-only">{SOURCE_LABELS[item.source]}</span>
          {state === "snoozed" && snoozedUntil ? (
            <Chip>
              <ClockCountdownIcon aria-hidden="true" className="size-3" />
              <span
                className="font-display tracking-[-0.01em] tabular-nums"
                suppressHydrationWarning
              >
                {snoozeReadout(snoozedUntil, now)}
              </span>
            </Chip>
          ) : undefined}
          {state === "dismissed" ? (
            <Chip>
              <ProhibitIcon aria-hidden="true" className="size-3" />
              Won't do
            </Chip>
          ) : undefined}
          {deadline ? (
            <span
              className={cn(
                "font-display tracking-[-0.01em] tabular-nums",
                deadline.overdue && "font-bold text-destructive",
              )}
              suppressHydrationWarning
            >
              {deadline.label}
            </span>
          ) : (
            <span className="font-display tracking-[-0.01em] tabular-nums" suppressHydrationWarning>
              {formatAge(item.anchorAt, now)}
            </span>
          )}
          {item.waiting !== undefined && item.waiting > 1 ? (
            <span className="font-display tracking-[-0.01em] tabular-nums" suppressHydrationWarning>
              {item.waiting} waiting
            </span>
          ) : undefined}
          {item.source === "drip-empty" ? (
            <span className="font-display tracking-[-0.01em] tabular-nums">0 queued</span>
          ) : undefined}
          {item.source === "artist-review" && item.reviewLinks ? (
            <span className="font-display tracking-[-0.01em] tabular-nums">
              {item.reviewLinks} to verify
            </span>
          ) : undefined}
          {item.machine ? (
            <Badge
              className="px-1 py-0 font-display text-[10px] text-muted-foreground"
              variant="outline"
            >
              {item.machine}
            </Badge>
          ) : undefined}
          {item.missing?.map((leg) => {
            const LegIcon = leg === "youtube" ? YoutubeIcon : MixcloudIcon;
            return (
              <span className="flex items-center" key={leg}>
                <LegIcon className="size-3" />
                <span className="sr-only">{leg} pending</span>
              </span>
            );
          })}
        </div>
        {/* The pre-chew sweep's advisory verdict — a quiet second line under the meta,
            never competing with the row's primary [Review] action (advisory, not a
            decision). Only submission rows carry it, and only once the sweep has run. */}
        {item.verdict ? (
          <p className="mt-0.5 truncate text-[11px] italic text-muted-foreground">{item.verdict}</p>
        ) : undefined}
      </div>

      <div className="flex items-center gap-1 max-sm:w-full max-sm:justify-end">
        {parked ? (
          <Button
            onClick={() => onRestore(item)}
            ref={(el: HTMLElement | null) => registerPrimary(item.id, el)}
            size="sm"
            variant={selected ? "default" : "outline"}
          >
            {state === "dismissed" ? (
              <>
                <ArrowCounterClockwiseIcon aria-hidden="true" />
                Restore
              </>
            ) : (
              "Unsnooze"
            )}
          </Button>
        ) : (
          <>
            <PrimaryButton
              busy={busy}
              copied={copied}
              item={item}
              onCopyCaption={onCopyCaption}
              onPush={onPush}
              onRePush={onRePush}
              primary={primary}
              pushing={pushing}
              registerPrimary={registerPrimary}
              selected={selected}
            />
            {canFinish ? (
              <MarkPostedPopover
                busy={busy}
                item={item}
                onCopyCover={onCopyCover}
                onMarkPosted={onMarkPosted}
                onOpenChange={onFinishOpenChange}
                open={finishOpen}
              />
            ) : undefined}
          </>
        )}
        {state !== "dismissed" ? (
          <>
            <Popover onOpenChange={onSnoozeOpenChange} open={snoozeOpen}>
              <PopoverTrigger
                render={
                  <Button
                    aria-label={`Snooze ${item.title}`}
                    size="icon-sm"
                    title="Snooze (s)"
                    variant="ghost"
                  >
                    <ClockCountdownIcon aria-hidden="true" />
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-40 p-1">
                <div className="flex flex-col">
                  {snoozeSlots(now).map((slot) => (
                    <Button
                      className="justify-start"
                      key={slot.label}
                      onClick={() => onSnooze(item, slot.until)}
                      size="sm"
                      variant="ghost"
                    >
                      {slot.label}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <Button
              aria-label={`Won't do ${item.title}`}
              onClick={() => onWontDo(item)}
              size="icon-sm"
              title="Won't do (x)"
              variant="ghost"
            >
              <ProhibitIcon aria-hidden="true" />
            </Button>
          </>
        ) : undefined}
      </div>
    </li>
  );
}

type PrimaryButtonProps = {
  busy: boolean;
  copied: boolean;
  item: AttentionItem;
  onCopyCaption: (item: AttentionItem) => void;
  onPush: (item: AttentionItem, platform: Platform) => void;
  onRePush: (item: AttentionItem) => void;
  primary: PrimaryAction;
  /** True while this row's platform push is in flight (a push-kind primary). */
  pushing: boolean;
  registerPrimary: (id: string, el: HTMLElement | null) => void;
  selected: boolean;
};

// The row's primary action — the one thing Enter fires. The selected row's
// primary carries the gold (the sun follows the cursor); every other row's stays
// an outline.
function PrimaryButton({
  busy,
  copied,
  item,
  onCopyCaption,
  onPush,
  onRePush,
  primary,
  pushing,
  registerPrimary,
  selected,
}: PrimaryButtonProps) {
  const variant = selected ? "default" : "outline";

  if (primary.kind === "open") {
    return (
      <Button
        nativeButton={false}
        render={
          <a
            href={primary.href}
            ref={(el: HTMLAnchorElement | null) => registerPrimary(item.id, el)}
          />
        }
        size="sm"
        variant={variant}
      >
        {primary.label}
      </Button>
    );
  }

  if (primary.kind === "push") {
    const platform = primary.platform;

    return (
      <Button
        disabled={pushing || !item.trackId}
        onClick={() => onPush(item, platform)}
        ref={(el: HTMLElement | null) => registerPrimary(item.id, el)}
        size="sm"
        variant={variant}
      >
        {pushing ? (
          <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
        ) : undefined}
        {primary.label}
      </Button>
    );
  }

  if (primary.kind === "re-push") {
    return (
      <Button
        disabled={busy}
        onClick={() => onRePush(item)}
        ref={(el: HTMLElement | null) => registerPrimary(item.id, el)}
        size="sm"
        variant={variant}
      >
        {busy ? (
          <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
        ) : undefined}
        {primary.label}
      </Button>
    );
  }

  return (
    <Button
      disabled={!item.logId}
      onClick={() => onCopyCaption(item)}
      ref={(el: HTMLElement | null) => registerPrimary(item.id, el)}
      size="sm"
      variant={variant}
    >
      {copied ? "Copied" : primary.label}
    </Button>
  );
}

// The "Mark posted" panel for a pushed TikTok draft: copy the cover to attach in-app, then
// paste the live URL to clear the row. The URL field is LOCAL to this popover, so one row's
// edit never leaks into another's (the old page-level markUrl surfaced the previous track's
// URL on a different row).
function MarkPostedPopover({
  busy,
  item,
  onCopyCover,
  onMarkPosted,
  onOpenChange,
  open,
}: {
  busy: boolean;
  item: AttentionItem;
  onCopyCover: (item: AttentionItem) => void;
  onMarkPosted: (item: AttentionItem, url: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const inputId = useId();
  const [url, setUrl] = useState("");
  const valid = isHttpUrl(url.trim());

  return (
    <Popover
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setUrl("");
        }
      }}
      open={open}
    >
      <PopoverTrigger
        render={
          <Button size="sm" variant="ghost">
            <PaperPlaneTiltIcon aria-hidden="true" />
            Mark posted
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72 space-y-3">
        <Button
          className="w-full justify-start"
          disabled={!item.logId}
          onClick={() => onCopyCover(item)}
          size="sm"
          variant="outline"
        >
          <ImageIcon aria-hidden="true" />
          Copy cover
        </Button>
        <div className="flex flex-col gap-2">
          <Label htmlFor={inputId}>Live URL</Label>
          <Input
            id={inputId}
            inputMode="url"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && valid) {
                event.preventDefault();
                onMarkPosted(item, url.trim());
              }
            }}
            placeholder="https://www.tiktok.com/…"
            value={url}
          />
          <Button
            className="w-full"
            disabled={busy || !valid}
            onClick={() => onMarkPosted(item, url.trim())}
            size="sm"
          >
            {busy ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : undefined}
            Mark posted
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="flex items-center gap-1">{children}</span>;
}

// The row's artwork tile. A failed load (a cover the dev bucket doesn't hold)
// falls back to the same tile a coverless object gets: the source glyph over the
// eclipse-tinted fallback (DESIGN.md, the Track Row's gold-to-red artwork
// fallback, at instrument size).
function RowArt({
  artUrl,
  Icon,
}: {
  artUrl?: string;
  Icon: ComponentType<{ className?: string }>;
}) {
  const [failed, setFailed] = useState(false);

  if (artUrl && !failed) {
    return (
      <img
        alt=""
        className="size-10 shrink-0 rounded-[6px] border border-border object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
        // A load that failed BEFORE hydration never re-fires `error`, so the
        // mount ref re-checks the finished-but-empty state.
        ref={(el) => {
          if (el && el.complete && el.naturalWidth === 0) {
            setFailed(true);
          }
        }}
        src={artUrl}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center rounded-[6px] border border-border bg-gradient-to-br from-primary/10 via-muted/30 to-destructive/10"
    >
      <Icon className="size-4 text-muted-foreground" />
    </div>
  );
}

// ─── The zero state ───────────────────────────────────────────────────────────

// The one sanctioned motion exception: the last cover cleared, warmly lit by a
// single gold bloom, one word,
// a 200ms ease-out settle. Reduced motion: static (styles.css, .queue-clear).
function ZeroState({ coverUrl }: { coverUrl?: string }) {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-6 overflow-hidden px-4 py-24">
      <div
        aria-hidden="true"
        className="absolute size-96 rounded-full bg-[radial-gradient(circle,_var(--gold-veil)_0%,_transparent_65%)]"
      />
      {coverUrl ? (
        <img
          alt=""
          className="queue-clear relative size-40 rounded-[6px] border border-primary/30 object-cover sm:size-48"
          src={coverUrl}
        />
      ) : undefined}
      <p className="queue-clear relative font-display text-2xl font-bold tracking-[-0.02em] text-primary">
        clear
      </p>
    </div>
  );
}

// ─── The key legend ───────────────────────────────────────────────────────────

function KeyLegend() {
  return (
    <p className="hidden items-center gap-3 text-[11px] text-muted-foreground md:flex">
      <span className="flex items-center gap-1">
        <Kbd>j</Kbd>
        <Kbd>k</Kbd> move
      </span>
      <span className="flex items-center gap-1">
        <Kbd>↵</Kbd> act
      </span>
      <span className="flex items-center gap-1">
        <Kbd>s</Kbd> snooze
      </span>
      <span className="flex items-center gap-1">
        <Kbd>x</Kbd> won't do
      </span>
    </p>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border bg-muted/40 px-1 font-mono text-[10px]">
      {children}
    </kbd>
  );
}
