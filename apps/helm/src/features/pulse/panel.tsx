// The pulse panel — the rig's heartbeat on one screen. The single next thing to
// post (cover, caption, the asset, the copy affordances), the render queue, the
// /api/status surface grid, the show's liveness, and the daemon's own vitals. Two
// polls: the cheap board (fast) and the next-to-post card (slower — it reads each
// finding's post state). Machine states read as a recovered terminal (VOICE.md):
// deadpan mono tokens, no traffic lights.

import {
  ArrowSquareOut,
  BellRinging,
  Broadcast,
  Check,
  Copy,
  FilmSlate,
  Pulse,
  Television,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@fluncle/ui/components/card";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import { cn } from "@fluncle/ui/lib/utils";

import { type RunStartedResponse } from "../../contract";
import { apiGet, apiPost } from "../../ui/api";
import { useHelm } from "../../ui/helm-context";
import {
  type NextToPostCard,
  type NudgeCheckResponse,
  type NudgeStatus,
  type PulseBoard,
  type PulseNext,
} from "./contract";
import { type ServiceHealth, type SurfaceRow } from "./logic";

const BOARD_POLL_MS = 15_000;
const NEXT_POLL_MS = 30_000;

// ─── time helpers ────────────────────────────────────────────────────────────

function durationLabel(minutes: number): string {
  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function sinceLabel(value: number | string | null, now: number): string | null {
  if (value === null) {
    return null;
  }

  const then = typeof value === "number" ? value : Date.parse(value);

  if (Number.isNaN(then)) {
    return null;
  }

  return durationLabel(Math.max(0, Math.floor((now - then) / 60_000)));
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    return false;
  }
}

/** Start polling a GET endpoint on an interval; returns the effect cleanup. */
function startPoll<T>(path: string, intervalMs: number, set: (value: T) => void): () => void {
  let cancelled = false;

  const read = async (): Promise<void> => {
    try {
      const value = await apiGet<T>(path);

      if (!cancelled) {
        set(value);
      }
    } catch {
      // A missed poll is not a state — the next tick answers.
    }
  };

  void read();
  const timer = setInterval(() => void read(), intervalMs);

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}

// ─── panel ───────────────────────────────────────────────────────────────────

export default function PulsePanel() {
  const [board, setBoard] = useState<PulseBoard | undefined>(undefined);
  const [next, setNext] = useState<PulseNext | undefined>(undefined);

  useEffect(() => startPoll("/api/pulse/board", BOARD_POLL_MS, setBoard), []);
  useEffect(() => startPoll("/api/pulse/next", NEXT_POLL_MS, setNext), []);

  return (
    <div className="grid max-w-3xl gap-6">
      <header className="grid gap-1">
        <h2 className="flex items-center gap-2 text-base font-extrabold text-foreground">
          <Pulse aria-hidden className="size-4 text-muted-foreground" />
          Pulse
        </h2>
        <p className="text-sm text-muted-foreground">
          The rig&rsquo;s heartbeat — what it&rsquo;s doing, and what it&rsquo;s waiting on.
        </p>
      </header>

      <NextToPost next={next} onNudged={setNext} />

      <div className="grid gap-6 md:grid-cols-2">
        <Queue board={board} />
        <Surfaces board={board} />
      </div>

      <Rig board={board} />
    </div>
  );
}

// ─── next to post ──────────────────────────────────────────────────────────

function NextToPost({
  next,
  onNudged,
}: {
  next: PulseNext | undefined;
  onNudged: (value: PulseNext) => void;
}) {
  if (next === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Next to post</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-4 w-48" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FilmSlate aria-hidden className="size-4 text-muted-foreground" />
          Next to post
        </CardTitle>
        <CardDescription>
          The oldest dressed finding still off TikTok. Post it by hand — the caption never survives
          the inbox, so it&rsquo;s here to copy.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {next.nextToPost ? (
          <NextCard card={next.nextToPost} />
        ) : (
          <p className="font-mono text-[0.82rem] text-muted-foreground">
            {next.error
              ? `[dark] admin — ${next.error}`
              : "[clear] caught up — everything dressed has gone out."}
          </p>
        )}
        <NudgeBar hasCard={Boolean(next.nextToPost)} nudge={next.nudge} onNudged={onNudged} />
      </CardContent>
    </Card>
  );
}

function NextCard({ card }: { card: NextToPostCard }) {
  return (
    <div className="grid gap-4">
      <div className="flex gap-4">
        {card.coverUrl ? (
          <img
            alt=""
            className="size-20 shrink-0 rounded-md object-cover ring-1 ring-border"
            src={card.coverUrl}
          />
        ) : (
          <div className="grid size-20 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground ring-1 ring-border">
            <FilmSlate aria-hidden className="size-6" />
          </div>
        )}
        <div className="grid min-w-0 content-start gap-1">
          <p className="truncate text-sm font-semibold text-foreground" title={card.artistTitle}>
            {card.artistTitle}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="font-mono" variant="outline">
              {card.logId}
            </Badge>
            <span className="text-xs text-muted-foreground">
              dressed {durationLabel(card.ageMinutes)} ago
            </span>
          </div>
        </div>
      </div>

      <CopyBlock caption={card.caption} />

      <AssetRow url={card.postAssetUrl} />

      <div className="flex flex-wrap gap-2">
        <Button
          render={<a href={card.adminUrl} rel="noreferrer" target="_blank" />}
          variant="outline"
        >
          <ArrowSquareOut aria-hidden data-icon="inline-start" />
          Push in /admin
        </Button>
        <Button render={<a href={card.logUrl} rel="noreferrer" target="_blank" />} variant="ghost">
          <ArrowSquareOut aria-hidden data-icon="inline-start" />
          Log page
        </Button>
      </div>
    </div>
  );
}

function CopyBlock({ caption }: { caption: string | null }) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    if (!caption) {
      return;
    }

    if (await copyToClipboard(caption)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }, [caption]);

  return (
    <div className="grid gap-2 rounded-md border bg-background/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Caption
        </span>
        <Button disabled={!caption} onClick={() => void onCopy()} size="xs" variant="outline">
          {copied ? (
            <Check aria-hidden data-icon="inline-start" />
          ) : (
            <Copy aria-hidden data-icon="inline-start" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {caption ? (
        <p className="helm-scroll max-h-40 overflow-y-auto text-sm whitespace-pre-wrap text-foreground/90">
          {caption}
        </p>
      ) : (
        <p className="font-mono text-xs text-muted-foreground">
          [dark] no note.txt on the bundle yet
        </p>
      )}
    </div>
  );
}

function AssetRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    if (await copyToClipboard(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }, [url]);

  return (
    <div className="flex items-center gap-2 rounded-md border bg-background/40 px-3 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={url}>
        {url}
      </span>
      <Button onClick={() => void onCopy()} size="xs" variant="outline">
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span className="sr-only">Copy asset URL</span>
      </Button>
      <Button render={<a href={url} rel="noreferrer" target="_blank" />} size="xs" variant="ghost">
        <ArrowSquareOut aria-hidden />
        <span className="sr-only">Open asset</span>
      </Button>
    </div>
  );
}

function nudgeLine(nudge: NudgeStatus, now: number): string {
  const age = sinceLabel(nudge.newestPostedAt, now);
  const threshold = `${nudge.thresholdHours}h`;

  switch (nudge.reason) {
    case "already-nudged-today":
      return `Nudged already today — ${age ?? "nothing"} since the last post.`;
    case "fresh":
      return `Last post ${age ?? "—"} ago — quiet until ${threshold}.`;
    case "no-unposted":
      return "Nothing dressed and waiting — the queue's clear.";
    case "stale":
      return age
        ? `${age} since the last post — a nudge is due.`
        : "Nothing's gone out yet — a nudge is due.";
  }
}

function NudgeBar({
  hasCard,
  nudge,
  onNudged,
}: {
  hasCard: boolean;
  nudge: NudgeStatus;
  onNudged: (value: PulseNext) => void;
}) {
  const [now] = useState(() => Date.now());
  const [state, setState] = useState<"idle" | "refused" | "sending" | "sent">("idle");

  const sendTest = useCallback(async () => {
    setState("sending");

    try {
      const result = await apiPost<NudgeCheckResponse>("/api/pulse/nudge/check", {
        fire: true,
        force: true,
      });
      setState(result.notified ? "sent" : "refused");
      // Refresh the card + status after a fire so the panel reflects the tick.
      const refreshed = await apiGet<PulseNext>("/api/pulse/next");
      onNudged(refreshed);
    } catch {
      setState("refused");
    }
  }, [onNudged]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
      <div className="grid gap-0.5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <BellRinging aria-hidden className="size-3.5" />
          {nudgeLine(nudge, now)}
        </span>
        <span aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
          {state === "sent"
            ? "Sent. Check the corner of your screen."
            : state === "refused"
              ? "osascript refused it — notification permissions, probably."
              : state === "sending"
                ? "Firing the nudge…"
                : ""}
        </span>
      </div>
      <Button
        disabled={state === "sending" || !hasCard}
        onClick={() => void sendTest()}
        size="sm"
        title={hasCard ? undefined : "Nothing to nudge about right now"}
        variant="outline"
      >
        <BellRinging aria-hidden data-icon="inline-start" />
        Send test nudge
      </Button>
    </div>
  );
}

// ─── queue ─────────────────────────────────────────────────────────────────

function Queue({ board }: { board: PulseBoard | undefined }) {
  const rows = board?.queue.rows;

  return (
    <Card className="min-h-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FilmSlate aria-hidden className="size-4 text-muted-foreground" />
          Render queue
        </CardTitle>
        <CardDescription>
          {board === undefined
            ? "Reading the backlog…"
            : board.queue.error
              ? "The admin API didn't answer."
              : rows && rows.length > 0
                ? `${rows.length}${rows.length === 20 ? "+" : ""} awaiting the camera, oldest first.`
                : "Caught up — nothing's waiting to film."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {board === undefined ? (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
        ) : board.queue.error ? (
          <p className="font-mono text-xs text-muted-foreground">[dark] {board.queue.error}</p>
        ) : rows && rows.length > 0 ? (
          <ul className="helm-scroll grid max-h-64 gap-1 overflow-y-auto">
            {rows.map((row) => (
              <li className="flex items-baseline justify-between gap-3 text-sm" key={row.logId}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{row.logId}</span>
                  <span className="truncate text-foreground/90">{row.artistTitle}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {durationLabel(row.ageMinutes)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-mono text-xs text-muted-foreground">
            [clear] the camera&rsquo;s caught up
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── surfaces ──────────────────────────────────────────────────────────────

const HEALTH_MARK: Record<ServiceHealth, string> = { degraded: "~", down: "x", ok: "+" };
const HEALTH_STYLE: Record<ServiceHealth, string> = {
  degraded: "text-primary",
  down: "text-destructive",
  ok: "text-foreground",
};

function Surfaces({ board }: { board: PulseBoard | undefined }) {
  const surfaces = board?.surfaces;
  const [now] = useState(() => Date.now());
  const freshness = sinceLabel(surfaces?.freshestReportAt ?? null, now);

  return (
    <Card className="min-h-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Broadcast aria-hidden className="size-4 text-muted-foreground" />
          Surfaces
        </CardTitle>
        <CardDescription>
          {board === undefined
            ? "Probing fluncle.com…"
            : surfaces?.error
              ? "The status probe didn't answer."
              : freshness
                ? `Snapshot ${freshness} old.`
                : "Live from /api/status."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {board === undefined ? (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : surfaces && surfaces.rows.length > 0 ? (
          <dl className="helm-scroll grid max-h-64 gap-1 overflow-y-auto font-mono text-[0.82rem]">
            {surfaces.rows.map((row) => (
              <SurfaceLine key={row.service} row={row} />
            ))}
          </dl>
        ) : (
          <p className="font-mono text-xs text-muted-foreground">
            [dark] {surfaces?.error ?? "no services reported"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SurfaceLine({ row }: { row: SurfaceRow }) {
  return (
    <div className="flex items-baseline gap-2" title={row.message ?? undefined}>
      <span aria-hidden className={cn("w-3 font-bold", HEALTH_STYLE[row.status])}>
        {HEALTH_MARK[row.status]}
      </span>
      <dt className="w-24 shrink-0 truncate text-foreground">{row.service}</dt>
      <dd className="text-muted-foreground">
        {row.status}
        {row.latencyMs !== null ? ` · ${row.latencyMs}ms` : ""}
      </dd>
    </div>
  );
}

// ─── rig (liveness + vitals) ─────────────────────────────────────────────────

function Rig({ board }: { board: PulseBoard | undefined }) {
  const { openRun } = useHelm();
  const [pinging, setPinging] = useState(false);

  const lineCheck = useCallback(async () => {
    setPinging(true);

    try {
      const { runId } = await apiPost<RunStartedResponse>("/api/pulse/ping");
      openRun("pulse", runId);
    } finally {
      setPinging(false);
    }
  }, [openRun]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Television aria-hidden className="size-4 text-muted-foreground" />
          The rig
        </CardTitle>
        <CardDescription>
          The show&rsquo;s liveness and the daemon&rsquo;s own vitals.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid gap-1.5 font-mono text-[0.82rem] leading-relaxed">
          {board === undefined ? (
            <>
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-48" />
            </>
          ) : (
            <>
              <TokenRow
                label="glass"
                note={board.live.glass === "up" ? "up on :4173" : "dark — no show running"}
                token={board.live.glass === "up" ? "clear" : "dark"}
              />
              <TokenRow
                label="bridge"
                note={board.live.bridge === "up" ? "up on :4180" : "dark — no show running"}
                token={board.live.bridge === "up" ? "clear" : "dark"}
              />
              <TokenRow
                label="daemon"
                note={`holding on :${board.vitals.port} · pid ${board.vitals.pid}`}
                token="clear"
              />
              <TokenRow
                label="machine"
                note={
                  board.vitals.machineBrand
                    ? `${board.vitals.machineBrand} (${board.vitals.machine})`
                    : board.vitals.machine
                }
                token={board.vitals.machine === "unknown" ? "dark" : "clear"}
              />
              <TokenRow
                label="up"
                note={durationLabel(Math.floor(board.vitals.uptimeMs / 60_000))}
                token="clear"
              />
              <TokenRow label="version" note={board.vitals.version} token="clear" />
              <TokenRow
                label="admin token"
                note={
                  board.vitals.adminTokenAboard
                    ? "aboard — the queue + next-to-post answer"
                    : "not aboard — admin reads will refuse (~/.config/fluncle)"
                }
                token={board.vitals.adminTokenAboard ? "clear" : "hold"}
              />
            </>
          )}
        </dl>
        <div>
          <Button disabled={pinging} onClick={() => void lineCheck()} size="sm" variant="outline">
            <Pulse aria-hidden data-icon="inline-start" />
            Line check
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const TOKEN_STYLES = {
  clear: "font-bold text-foreground",
  dark: "text-muted-foreground",
  hold: "font-bold text-destructive",
} as const;

function TokenRow({
  label,
  note,
  token,
}: {
  label: string;
  note: string;
  token: keyof typeof TOKEN_STYLES;
}) {
  return (
    <div className="flex gap-3">
      <span aria-hidden className={cn("w-14", TOKEN_STYLES[token])}>
        [{token}]
      </span>
      <dt className="w-28 shrink-0 text-foreground">{label}</dt>
      <dd className="text-muted-foreground">{note}</dd>
    </div>
  );
}
