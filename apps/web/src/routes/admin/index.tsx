import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CassetteTapeIcon,
  CircleNotchIcon,
  ClockCountdownIcon,
  EnvelopeSimpleIcon,
  FilmSlateIcon,
  GitDiffIcon,
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
import { ensureAdmin } from "@/lib/admin-guard";
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
  formatDelta,
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

const QUEUE_KEY = ["admin", "attention"] as const;

const DISTRIBUTE_KEY = ["admin", "attention-distribute"] as const;

const fetchAttention = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return readAttentionSnapshot();
});

const fetchCaption = createServerFn({ method: "GET" })
  .validator((data: { logId: string; trackId?: string }) => data)
  .handler(async ({ data }): Promise<{ caption: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const captions = await readCaptions([data.logId]);
    const raw = captions[data.logId] ?? "";

    return { caption: await captionForPlatform(data.trackId ?? "", "tiktok", raw) };
  });

type QueueSearch = {
  all?: true;

  mix?: string;
  stage?: string;
};

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

async function copyOrDownloadCover(
  url: string,
  filename: string,
): Promise<"copied" | "downloaded"> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const png = await coverToPngBlob(url);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return "copied";
    } catch {}
  }
  downloadUrl(url, filename);
  return "downloaded";
}

function AdminQueuePage() {
  const { snapshot: initial } = Route.useLoaderData();
  const { all: showAll = false } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const {
    busy: pushBusy,
    error: pushError,
    pushDraft,
    setError: setPushError,
  } = usePublish(DISTRIBUTE_KEY);

  const { data, error: queryError } = useQuery({
    initialData: initial,
    queryFn: () => fetchAttention(),
    queryKey: QUEUE_KEY,
    refetchOnWindowFocus: true,
  });

  const prefs = useQueuePrefs();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const [clearedIds, setClearedIds] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(
    () => data.items.filter((item) => !clearedIds.has(item.id)),
    [clearedIds, data.items],
  );

  useEffect(() => {
    pruneQueuePrefs(new Set(data.items.map((item) => item.id)));
  }, [data.items]);

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

  const visibleRef = useRef(visible);
  visibleRef.current = visible;

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

  const [busyId, setBusyId] = useState<string | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();
  const [flashId, setFlashId] = useState<string | undefined>();
  const [leavingId, setLeavingId] = useState<string | undefined>();
  const [snoozeFor, setSnoozeFor] = useState<string | undefined>();

  const [finishFor, setFinishFor] = useState<string | undefined>();

  const [lastCleared, setLastCleared] = useState<{ artUrl?: string } | undefined>();

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

  const rePush = useCallback(
    async (item: AttentionItem) => {
      if (!item.trackId || busyId) {
        return;
      }
      setBusyId(item.id);
      try {
        const response = await fetch(`/api/v1/admin/tracks/${item.trackId}/social/tiktok/draft`, {
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

  const markPosted = useCallback(
    async (item: AttentionItem, url: string) => {
      if (!item.trackId || busyId) {
        return;
      }
      setBusyId(item.id);
      try {
        const response = await fetch(`/api/v1/admin/tracks/${item.trackId}/social/tiktok`, {
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

  const resolveAnchorReview = useCallback(
    async (item: AttentionItem, resolution: "accepted" | "dismissed") => {
      if (!item.trackId || busyId) {
        return;
      }
      setBusyId(item.id);
      try {
        const response = await fetch(
          `/api/v1/admin/catalogue/anchor/reviews/${encodeURIComponent(item.trackId)}/resolve`,
          {
            body: JSON.stringify({ resolution }),
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        const result = (await response.json()) as { message?: string; ok?: boolean };
        if (!response.ok || !result.ok) {
          throw new Error(result.message ?? `Ruling failed (${response.status})`);
        }
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

  const resolveBioReview = useCallback(
    async (item: AttentionItem, resolution: "keep" | "rewrite") => {
      const entity = item.entity;
      if (!entity || busyId) {
        return;
      }
      setBusyId(item.id);
      try {
        const response = await fetch(
          `/api/v1/admin/bio-reviews/${encodeURIComponent(entity.kind)}/${encodeURIComponent(entity.slug)}/resolve`,
          {
            body: JSON.stringify({ resolution }),
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        const result = (await response.json()) as { message?: string; ok?: boolean };
        if (!response.ok || !result.ok) {
          throw new Error(result.message ?? `Ruling failed (${response.status})`);
        }
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

  const copyCover = useCallback((item: AttentionItem) => {
    if (!item.logId) {
      return;
    }
    const { coverUrl } = trackMedia(item.logId);
    void copyOrDownloadCover(coverUrl, `${item.logId}-cover.jpg`).then((mode) => {
      toast(mode === "copied" ? "Cover copied to the clipboard" : "Cover downloaded");
    });
  }, []);

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
              onResolveAnchorReview={resolveAnchorReview}
              onResolveBioReview={resolveBioReview}
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

const SOURCE_ICONS: Record<AttentionSource, ComponentType<{ className?: string }>> = {
  "anchor-review": GitDiffIcon,
  "artist-review": MicrophoneStageIcon,
  "attach-cues": FilmSlateIcon,
  "bio-review": QuotesIcon,
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

const SOURCE_LABELS: Record<AttentionSource, string> = {
  "anchor-review": "Version check",
  "artist-review": "Artist",
  "attach-cues": "Recording",
  "bio-review": "Bio past the gate",
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
  onResolveAnchorReview: (item: AttentionItem, resolution: "accepted" | "dismissed") => void;
  onResolveBioReview: (item: AttentionItem, resolution: "keep" | "rewrite") => void;
  onRestore: (item: AttentionItem) => void;
  onSelect: (id: string) => void;
  onSnooze: (item: AttentionItem, until: string) => void;
  onSnoozeOpenChange: (open: boolean) => void;
  onWontDo: (item: AttentionItem) => void;

  pushBusy: Record<string, boolean>;
  registerPrimary: (id: string, el: HTMLElement | null) => void;
  registerRow: (id: string, el: HTMLLIElement | null) => void;
  selected: boolean;
  snoozeOpen: boolean;
  snoozedUntil?: string;
  state: RowState;
};

function queueRowState(
  item: AttentionItem,
  now: number,
  state: RowState,
  pushBusy: Record<string, boolean>,
) {
  const deadline = item.deadlineAt ? deadlineReadout(item.deadlineAt, now) : undefined;
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
  const candidate = item.source === "anchor-review" ? item.candidate : undefined;
  const bioEntity = item.source === "bio-review" ? item.entity : undefined;
  return {
    bioEntity,
    bioViolations: bioEntity ? (item.violations ?? []) : [],
    candidate,
    deadline,
    parked: state === "snoozed" || state === "dismissed",
    pushPlatform,
    pushing,
  };
}

function visibleWaitingCount(item: AttentionItem): number | undefined {
  return item.waiting !== undefined && item.waiting > 1 ? item.waiting : undefined;
}

function candidateArtistsSuffix(artists: string[]): string {
  return artists.length > 0 ? ` — ${artists.join(", ")}` : "";
}

function queueRowSelectionClass(selected: boolean): string {
  return selected ? "bg-primary/10" : "hover:bg-primary/5";
}

function bioViolationSummary(violations: string[]): string {
  return violations.length > 0 ? violations.join("; ") : "no reasons recorded";
}

function candidateDescriptorLabel(descriptor: string): string {
  return descriptor || "no version";
}

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
  onResolveAnchorReview,
  onResolveBioReview,
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

  const canFinish = item.source === "tiktok-draft";

  const { bioEntity, bioViolations, candidate, deadline, parked, pushing } = queueRowState(
    item,
    now,
    state,
    pushBusy,
  );
  const waitingCount = visibleWaitingCount(item);

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- pointer shortcut for an existing, complete keyboard path (see above).
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-3 py-2.5 transition-[opacity,background-color] duration-200 ease-out last:border-0 sm:px-4",
        queueRowSelectionClass(selected),
        flash && "bg-primary/15",

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
          {waitingCount ? (
            <span className="font-display tracking-[-0.01em] tabular-nums" suppressHydrationWarning>
              {waitingCount} waiting
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

          {candidate ? (
            <span className="font-display tracking-[-0.01em] tabular-nums">
              {formatDelta(candidate.deltaMs)}
            </span>
          ) : undefined}

          {bioEntity ? (
            <Badge
              className="px-1 py-0 font-display text-[10px] text-muted-foreground"
              variant="outline"
            >
              {bioEntity.kind}
            </Badge>
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

        {item.verdict ? (
          <p className="mt-0.5 truncate text-[11px] italic text-muted-foreground">{item.verdict}</p>
        ) : undefined}

        {candidate ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate">
              Candidate: {candidate.title}
              {candidateArtistsSuffix(candidate.artists)}
            </span>
            <Badge
              className="shrink-0 px-1 py-0 font-display text-[10px] text-muted-foreground"
              variant="outline"
            >
              {candidateDescriptorLabel(candidate.descriptor)}
            </Badge>
          </p>
        ) : undefined}

        {bioEntity ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate">Gate said: {bioViolationSummary(bioViolations)}</span>
            <Button
              className="h-auto shrink-0 px-1 py-0 text-[11px]"
              nativeButton={false}
              render={
                <a
                  aria-label={`Read the bio on the ${bioEntity.kind} page — ${item.title}`}
                  href={`/${bioEntity.kind}/${bioEntity.slug}`}
                  rel="noreferrer"
                  target="_blank"
                />
              }
              size="sm"
              variant="link"
            >
              Read it
            </Button>
          </p>
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
              onAcceptAnchor={(target) => onResolveAnchorReview(target, "accepted")}
              onCopyCaption={onCopyCaption}
              onKeepBio={(target) => onResolveBioReview(target, "keep")}
              onPush={onPush}
              onRePush={onRePush}
              primary={primary}
              pushing={pushing}
              registerPrimary={registerPrimary}
              selected={selected}
            />
            {bioEntity ? (
              <Button
                disabled={busy}
                onClick={() => onResolveBioReview(item, "rewrite")}
                size="sm"
                variant="ghost"
              >
                Send it back
              </Button>
            ) : undefined}
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
            {candidate ? (
              <>
                <Button
                  disabled={busy}
                  onClick={() => onResolveAnchorReview(item, "dismissed")}
                  size="sm"
                  variant="ghost"
                >
                  Not a match
                </Button>

                {item.mbUrl && primary.kind !== "open" ? (
                  <Button
                    nativeButton={false}
                    render={
                      <a
                        aria-label={`Open ${item.title} in MusicBrainz`}
                        href={item.mbUrl}
                        rel="noreferrer"
                        target="_blank"
                      />
                    }
                    size="icon-sm"
                    title="Open in MusicBrainz"
                    variant="ghost"
                  >
                    <ArrowSquareOutIcon aria-hidden="true" />
                  </Button>
                ) : undefined}
              </>
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
  onAcceptAnchor: (item: AttentionItem) => void;
  onCopyCaption: (item: AttentionItem) => void;
  onKeepBio: (item: AttentionItem) => void;
  onPush: (item: AttentionItem, platform: Platform) => void;
  onRePush: (item: AttentionItem) => void;
  primary: PrimaryAction;

  pushing: boolean;
  registerPrimary: (id: string, el: HTMLElement | null) => void;
  selected: boolean;
};

function PrimaryButton({
  busy,
  copied,
  item,
  onAcceptAnchor,
  onCopyCaption,
  onKeepBio,
  onPush,
  onRePush,
  primary,
  pushing,
  registerPrimary,
  selected,
}: PrimaryButtonProps) {
  const variant = selected ? "default" : "outline";

  if (primary.kind === "accept-anchor") {
    return (
      <Button
        disabled={busy}
        onClick={() => onAcceptAnchor(item)}
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

  if (primary.kind === "keep-bio") {
    return (
      <Button
        disabled={busy || !item.entity}
        onClick={() => onKeepBio(item)}
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

  if (primary.kind === "open") {
    return (
      <Button
        nativeButton={false}
        render={
          <a
            aria-label={`${primary.label} — ${item.title}`}
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
        className="size-10 shrink-0 rounded-[var(--rounded-artwork)] border border-border object-cover"
        loading="lazy"
        onError={() => setFailed(true)}

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
      className="flex size-10 shrink-0 items-center justify-center rounded-[var(--rounded-artwork)] border border-border bg-gradient-to-br from-primary/10 via-muted/30 to-destructive/10"
    >
      <Icon className="size-4 text-muted-foreground" />
    </div>
  );
}

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
          className="queue-clear relative size-40 rounded-[var(--rounded-artwork)] border border-primary/30 object-cover sm:size-48"
          src={coverUrl}
        />
      ) : undefined}
      <p className="queue-clear relative font-display text-2xl font-bold tracking-[-0.02em] text-primary">
        clear
      </p>
    </div>
  );
}

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
