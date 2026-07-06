// The set-lifecycle panel — the post-set ritual as one board. The shelf
// (listRecordings) lays a set's whole life out in three lanes, left to right:
// plan → take → promoted. Capture lives above it (M5); the per-take actions
// (derive + attach cues on M2, promote anywhere, distribute on M5) hang off each
// row and gate themselves on the machine. Long actions stream into the run drawer
// via openRun; the quick admin mutations answer in place and refresh the shelf.
//
// Voice: a recovered console (VOICE.md, the Depth Gradient) — deadpan machine
// states, no traffic lights, the [plan]/[take]/[F] tokens carried from show.ts.

import {
  ArrowClockwise,
  Broadcast,
  CircleNotch,
  FilmSlate,
  ListNumbers,
  UploadSimple,
  VinylRecord,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@fluncle/ui/components/alert-dialog";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import { cn } from "@fluncle/ui/lib/utils";

import { type MachineId, type RunStartedResponse } from "../../contract";
import { ApiError, apiGet, apiPost } from "../../ui/api";
import { useHelm } from "../../ui/helm-context";
import { type DerivedCues, toReplaceCuesPayload } from "./cues";
import {
  canRunOn,
  cueCount,
  groupByStage,
  type Recording,
  STAGE_META,
  STAGE_ORDER,
  type Stage,
  stageOf,
} from "./lifecycle";
import { type MovieEntry, takeDefaultsFromFilename } from "./scan";

const SHELF_POLL_MS = 8000;

type ShelfResponse = { ok: true; recordings: Recording[] };
type MastersResponse = { audios: MovieEntry[]; videos: MovieEntry[] };

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  }

  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || ms <= 0) {
    return undefined;
  }

  const seconds = Math.round(ms / 1000);

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) {
    return "—";
  }

  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

export default function SetLifecyclePanel() {
  const { machine } = useHelm();
  const [shelf, setShelf] = useState<Recording[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [minted, setMinted] = useState<{ logId: string; title: string } | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const response = await apiGet<ShelfResponse>("/api/set-lifecycle/recordings");
      setShelf(response.recordings);
      setError(undefined);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "admin_error"
          ? "The admin token isn't aboard: the shelf can't answer (~/.config/fluncle)."
          : caught instanceof Error
            ? caught.message
            : "The shelf didn't answer.",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), SHELF_POLL_MS);

    return () => clearInterval(timer);
  }, [refresh]);

  const groups = shelf ? groupByStage(shelf) : undefined;

  return (
    <div className="grid max-w-5xl gap-6">
      <header className="grid gap-1">
        <h2 className="flex items-center gap-2 text-base font-extrabold text-foreground">
          <VinylRecord aria-hidden className="size-4 text-muted-foreground" />
          Set lifecycle
        </h2>
        <p className="text-sm text-muted-foreground">
          The post-set ritual: capture a take, derive its cues, promote it, distribute the masters.
        </p>
      </header>

      {canRunOn(machine, "m5") ? <CaptureTake onUploaded={() => void refresh()} /> : null}

      {minted ? (
        <p
          aria-live="polite"
          className="rounded-md border border-primary/40 bg-primary/5 px-4 py-2 font-mono text-[0.82rem] text-foreground"
        >
          <span className="font-bold">[F]</span> minted{" "}
          <span className="font-display font-bold tabular-nums">fluncle://{minted.logId}</span> from
          “{minted.title}”. It rode into the promoted lane.
        </p>
      ) : null}

      <section aria-label="The take shelf" className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-extrabold text-foreground">The shelf</h3>
          <Button onClick={() => void refresh()} size="xs" variant="ghost">
            <ArrowClockwise aria-hidden data-icon="inline-start" />
            Refresh
          </Button>
        </div>

        {error ? (
          <p className="rounded-md border bg-card/40 px-4 py-3 font-mono text-[0.82rem] text-muted-foreground">
            <span className="text-destructive">[hold]</span> {error}
          </p>
        ) : groups === undefined ? (
          <ShelfSkeleton />
        ) : shelf && shelf.length === 0 ? (
          <p className="rounded-md border bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">
            No recordings on the spine yet. Capture a take, or pencil a plan in{" "}
            <span className="font-mono">/admin/plans</span>.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            {STAGE_ORDER.map((stage) => (
              <Lane
                key={stage}
                machine={machine}
                onChanged={() => void refresh()}
                onPromoted={(logId, title) => {
                  setMinted({ logId, title });
                  void refresh();
                }}
                recordings={groups[stage]}
                stage={stage}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ShelfSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {STAGE_ORDER.map((stage) => (
        <div className="grid gap-2" key={stage}>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-20 w-full" />
        </div>
      ))}
    </div>
  );
}

type LaneProps = {
  machine: MachineId;
  onChanged: () => void;
  onPromoted: (logId: string, title: string) => void;
  recordings: Recording[];
  stage: Stage;
};

function Lane({ machine, onChanged, onPromoted, recordings, stage }: LaneProps) {
  const meta = STAGE_META[stage];

  return (
    <div className="grid content-start gap-2">
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden
          className={cn(
            "font-mono text-xs",
            stage === "promoted" ? "font-bold text-primary" : "text-muted-foreground",
          )}
        >
          [{meta.token}]
        </span>
        <h4 className="text-sm font-bold text-foreground">{meta.label}</h4>
        <span className="text-xs text-muted-foreground">{recordings.length}</span>
      </div>
      <p className="text-xs text-muted-foreground">{meta.blurb}</p>

      {recordings.length === 0 ? (
        <p className="rounded-md border border-dashed bg-card/20 px-3 py-4 text-center text-xs text-muted-foreground">
          empty
        </p>
      ) : (
        <ul className="grid gap-2">
          {recordings.map((recording) => (
            <RecordingRow
              key={recording.id}
              machine={machine}
              onChanged={onChanged}
              onPromoted={onPromoted}
              recording={recording}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

type RecordingRowProps = {
  machine: MachineId;
  onChanged: () => void;
  onPromoted: (logId: string, title: string) => void;
  recording: Recording;
};

function RecordingRow({ machine, onChanged, onPromoted, recording }: RecordingRowProps) {
  const stage = stageOf(recording);
  const cues = cueCount(recording);

  return (
    <li className="grid gap-2 rounded-md border bg-card/40 p-3">
      <div className="grid gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground" title={recording.title}>
            {recording.title}
          </span>
          {recording.version > 1 ? (
            <Badge className="shrink-0" variant="outline">
              v{recording.version}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[0.72rem] text-muted-foreground">
          {stage === "promoted" && recording.logId ? (
            <span className="font-display font-bold tabular-nums text-primary">
              fluncle://{recording.logId}
            </span>
          ) : null}
          <span>{cues === 0 ? "no cues" : `${cues} cue${cues === 1 ? "" : "s"}`}</span>
          <span>rec {formatDate(recording.recordedAt)}</span>
          {recording.durationMs ? <span>{formatDuration(recording.durationMs)}</span> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {stage === "plan" ? (
          canRunOn(machine, "m2") ? (
            <PlanExportButton planId={recording.id} />
          ) : (
            <MachineHint target="M2">export to Rekordbox</MachineHint>
          )
        ) : null}

        {stage === "take" ? (
          <>
            {canRunOn(machine, "m2") ? (
              <CueDialog onAttached={onChanged} recording={recording} />
            ) : (
              <MachineHint target="M2">attach cues</MachineHint>
            )}
            <PromoteButton onPromoted={onPromoted} recording={recording} />
          </>
        ) : null}

        {stage === "promoted" && recording.logId ? (
          canRunOn(machine, "m5") ? (
            <DistributeDialog logId={recording.logId} title={recording.title} />
          ) : (
            <MachineHint target="M5">distribute</MachineHint>
          )
        ) : null}
      </div>
    </li>
  );
}

function MachineHint({ children, target }: { children: string; target: "M2" | "M5" }) {
  return (
    <span className="font-mono text-[0.72rem] text-muted-foreground">
      {children} → <span className="font-bold text-foreground/80">{target}</span>
    </span>
  );
}

// ── Capture a take (M5) ────────────────────────────────────────────────────────

function CaptureTake({ onUploaded }: { onUploaded: () => void }) {
  const { openRun } = useHelm();
  const [videos, setVideos] = useState<MovieEntry[] | undefined>(undefined);
  const [selected, setSelected] = useState<MovieEntry | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [recordedAt, setRecordedAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await apiGet<MastersResponse>("/api/set-lifecycle/masters");

        if (!cancelled) {
          setVideos(response.videos);
        }
      } catch {
        if (!cancelled) {
          setVideos([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function pick(video: MovieEntry): void {
    setSelected(video);
    const defaults = takeDefaultsFromFilename(video.name, video.modifiedMs);
    setTitle(defaults.title);
    setRecordedAt(defaults.recordedAt);
  }

  async function upload(): Promise<void> {
    if (!selected || title.trim().length === 0) {
      return;
    }

    setBusy(true);

    try {
      const { runId } = await apiPost<RunStartedResponse>("/api/set-lifecycle/upload", {
        path: selected.path,
        recordedAt: recordedAt.trim() || undefined,
        title: title.trim(),
      });
      openRun("set-lifecycle", runId);
      setSelected(undefined);
      setTitle("");
      setRecordedAt("");
      onUploaded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Capture a take" className="grid gap-3 rounded-lg border bg-card/40 p-4">
      <div className="flex items-center gap-2">
        <FilmSlate aria-hidden className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-extrabold text-foreground">Capture a take</h3>
        <span className="ml-auto font-mono text-[0.72rem] text-muted-foreground">
          ~/Movies · M5
        </span>
      </div>

      {videos === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : videos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing in ~/Movies to stage. Record a set with OBS and it lands here.
        </p>
      ) : (
        <ul className="helm-scroll grid max-h-44 gap-1 overflow-y-auto">
          {videos.map((video) => (
            <li key={video.path}>
              <button
                aria-current={selected?.path === video.path ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
                  selected?.path === video.path
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => pick(video)}
                type="button"
              >
                <span className="truncate text-sm font-medium text-foreground">{video.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[0.72rem]">
                  {formatBytes(video.sizeBytes)}
                  {formatDuration(video.durationMs) ? ` · ${formatDuration(video.durationMs)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <div className="grid gap-3 border-t pt-3">
          <div className="grid gap-1.5">
            <Label htmlFor="take-title">Title</Label>
            <Input
              id="take-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Set 2026-07-05"
              value={title}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="take-recorded">Recorded at (ISO)</Label>
            <Input
              className="font-mono text-xs"
              id="take-recorded"
              onChange={(event) => setRecordedAt(event.target.value)}
              placeholder="2026-07-05T11:29:50.000Z"
              value={recordedAt}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={busy || title.trim().length === 0} onClick={() => void upload()}>
              <UploadSimple aria-hidden data-icon="inline-start" />
              {busy ? "Staging…" : "Upload take"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Runs local-direct: the multi-GB push streams to the drawer.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── Plan → tools export (M2) ────────────────────────────────────────────────────

function PlanExportButton({ planId }: { planId: string }) {
  const { openRun } = useHelm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);

    try {
      const { runId } = await apiPost<RunStartedResponse>("/api/set-lifecycle/plan-export", {
        planId,
      });
      openRun("set-lifecycle", runId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            <ListNumbers aria-hidden data-icon="inline-start" />
            Export to tools
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export this plan to Rekordbox + Beatport + m3u8?</DialogTitle>
          <DialogDescription>
            Writes a playlist straight into <span className="font-mono">master.db</span> (backed up
            first), and prints the Beatport links, m3u8, and a checklist.{" "}
            <span className="font-medium text-foreground">Quit Rekordbox fully before running</span>
            . It holds an exclusive lock on the database.
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-md border bg-card/40 px-3 py-2 font-mono text-[0.82rem] text-muted-foreground">
          <span className="font-bold text-destructive">[hold]</span> The run streams to the drawer.
          If Rekordbox is open, it falls back to text-only.
        </p>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost">Hold</Button>} />
          <Button disabled={busy} onClick={() => void run()}>
            {busy ? "Exporting…" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Derive + attach cues (M2) ───────────────────────────────────────────────────

type CuePhase = "deriving" | "error" | "idle" | "ready";

const BUCKET_MARK = { ambiguous: "?", matched: "+", unmatched: "x" } as const;

function CueDialog({ onAttached, recording }: { onAttached: () => void; recording: Recording }) {
  const { openRun } = useHelm();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState("");
  const [phase, setPhase] = useState<CuePhase>("idle");
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [derived, setDerived] = useState<DerivedCues | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [attaching, setAttaching] = useState(false);
  const [attached, setAttached] = useState(false);

  function reset(): void {
    setPhase("idle");
    setRunId(undefined);
    setDerived(undefined);
    setMessage(undefined);
    setAttached(false);
  }

  // Poll the completed derivation run for its parsed cues (409 while it reads
  // Rekordbox, 200 with the cue set once done, 422 if it printed nothing).
  useEffect(() => {
    if (phase !== "deriving" || !runId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async (): Promise<void> => {
      try {
        const response = await apiGet<{ ok: true } & DerivedCues>(
          `/api/set-lifecycle/runs/${runId}/cues`,
        );

        if (cancelled) {
          return;
        }

        setDerived(response);
        setPhase("ready");
      } catch (caught) {
        if (cancelled) {
          return;
        }

        if (caught instanceof ApiError && caught.code === "still_running") {
          timer = setTimeout(() => void poll(), 1500);
          return;
        }

        setMessage(
          caught instanceof Error ? caught.message : "The derivation failed. Read the run log.",
        );
        setPhase("error");
      }
    };

    timer = setTimeout(() => void poll(), 800);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, runId]);

  async function derive(): Promise<void> {
    setPhase("deriving");
    setMessage(undefined);
    setDerived(undefined);

    try {
      const started = await apiPost<RunStartedResponse>("/api/set-lifecycle/derive-cues", {
        session: session.trim() || undefined,
      });
      setRunId(started.runId);
      openRun("set-lifecycle", started.runId);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Couldn't start the derivation.");
      setPhase("error");
    }
  }

  async function attach(): Promise<void> {
    if (!derived) {
      return;
    }

    setAttaching(true);

    try {
      await apiPost(`/api/set-lifecycle/recordings/${recording.id}/cues`, {
        cues: toReplaceCuesPayload(derived),
      });
      setAttached(true);
      onAttached();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The attach was refused.");
      setPhase("error");
    } finally {
      setAttaching(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);

        if (!next) {
          reset();
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            <ListNumbers aria-hidden data-icon="inline-start" />
            Attach cues
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Derive cues for “{recording.title}”</DialogTitle>
          <DialogDescription>
            Reads the latest Rekordbox session, matches each track to a finding, and attaches the
            ordered cues to this take.{" "}
            <span className="font-medium text-foreground">Quit Rekordbox fully first</span>. It
            locks <span className="font-mono">master.db</span>. Mix-in times are marked later on the
            Studio cue rail.
          </DialogDescription>
        </DialogHeader>

        {attached ? (
          <p className="rounded-md border border-primary/40 bg-primary/5 px-4 py-3 font-mono text-[0.82rem] text-foreground">
            <span className="font-bold">[clear]</span> attached {derived?.cues.length ?? 0} cues to
            this take. Mark the mix-ins in the Studio.
          </p>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="cue-session">Session (optional, a name substring)</Label>
              <Input
                disabled={phase === "deriving"}
                id="cue-session"
                onChange={(event) => setSession(event.target.value)}
                placeholder="latest session"
                value={session}
              />
            </div>

            {phase === "deriving" ? (
              <p className="flex items-center gap-2 font-mono text-[0.82rem] text-muted-foreground">
                <CircleNotch
                  aria-hidden
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
                reading Rekordbox, watch the drawer…
              </p>
            ) : null}

            {phase === "error" && message ? (
              <p className="rounded-md border bg-card/40 px-3 py-2 font-mono text-[0.82rem] text-destructive">
                [hold] {message}
              </p>
            ) : null}

            {phase === "ready" && derived ? <CuePreview derived={derived} /> : null}
          </>
        )}

        <DialogFooter>
          {attached ? (
            <DialogClose render={<Button variant="outline">Done</Button>} />
          ) : (
            <>
              <DialogClose render={<Button variant="ghost">Cancel</Button>} />
              {phase === "ready" && derived ? (
                <Button disabled={attaching} onClick={() => void attach()}>
                  {attaching ? "Attaching…" : `Attach ${derived.cues.length} cues`}
                </Button>
              ) : (
                <Button disabled={phase === "deriving"} onClick={() => void derive()}>
                  <ListNumbers aria-hidden data-icon="inline-start" />
                  {phase === "deriving" ? "Deriving…" : "Derive from Rekordbox"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CuePreview({ derived }: { derived: DerivedCues }) {
  const { counts, cues, prunedConsecutive, session } = derived;

  return (
    <div className="grid gap-2">
      <p className="font-mono text-[0.72rem] text-muted-foreground">
        {session ? `${session} · ` : ""}
        {cues.length} cues · {counts.matched} matched
        {counts.fuzzy > 0 ? ` (${counts.fuzzy} fuzzy)` : ""} · {counts.unmatched} unmatched ·{" "}
        {counts.ambiguous} ambiguous
        {prunedConsecutive > 0 ? ` · ${prunedConsecutive} pruned` : ""}
      </p>
      <ol className="helm-scroll grid max-h-52 gap-0.5 overflow-y-auto rounded-md border bg-card/40 p-2 font-mono text-[0.72rem]">
        {cues.map((cue) => (
          <li className="flex items-baseline gap-2" key={cue.position}>
            <span
              aria-hidden
              className={cn(
                "w-3 shrink-0",
                cue.matchBucket === "matched" ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {cue.fuzzy ? "≈" : BUCKET_MARK[cue.matchBucket]}
            </span>
            <span className="w-5 shrink-0 text-right text-muted-foreground">{cue.position}.</span>
            <span className="min-w-0 flex-1 truncate text-foreground">
              {cue.artistsText} — {cue.titleText}
            </span>
            {cue.findingId ? (
              <span className="shrink-0 text-primary">{cue.findingId}</span>
            ) : (
              <span className="shrink-0 text-muted-foreground">{cue.matchBucket}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Promote (any machine) ───────────────────────────────────────────────────────

function PromoteButton({
  onPromoted,
  recording,
}: {
  onPromoted: (logId: string, title: string) => void;
  recording: Recording;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  async function promote(): Promise<void> {
    setBusy(true);
    setMessage(undefined);

    try {
      const response = await apiPost<{ ok: true; recording: Recording }>(
        `/api/set-lifecycle/recordings/${recording.id}/promote`,
      );
      const logId = response.recording.logId ?? "";
      setOpen(false);
      onPromoted(logId, recording.title);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Promote was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger
        render={
          <Button size="xs" variant="outline">
            <VinylRecord aria-hidden data-icon="inline-start" />
            Promote
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Promote this take to a mixtape?</AlertDialogTitle>
          <AlertDialogDescription>
            A mixtape is born only via promote. This mints a scarce, permanent{" "}
            <span className="font-bold text-foreground">F</span>-marked Log ID from “
            {recording.title}”, seeds its tracklist, and stages the set video. Idempotent: if it
            already links a mixtape, that one is reused.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {message ? (
          <p className="rounded-md border bg-card/40 px-3 py-2 font-mono text-[0.82rem] text-destructive">
            [hold] {message}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Hold</AlertDialogCancel>
          <Button disabled={busy} onClick={() => void promote()}>
            {busy ? "Minting…" : "Promote"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Distribute (M5) ─────────────────────────────────────────────────────────────

function DistributeDialog({ logId, title }: { logId: string; title: string }) {
  const { openRun } = useHelm();
  const [open, setOpen] = useState(false);
  const [masters, setMasters] = useState<MastersResponse | undefined>(undefined);
  const [video, setVideo] = useState<string | undefined>(undefined);
  const [audio, setAudio] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || masters) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await apiGet<MastersResponse>("/api/set-lifecycle/masters");

        if (!cancelled) {
          setMasters(response);
        }
      } catch {
        if (!cancelled) {
          setMasters({ audios: [], videos: [] });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, masters]);

  async function distribute(): Promise<void> {
    if (!video && !audio) {
      return;
    }

    setBusy(true);

    try {
      const { runId } = await apiPost<RunStartedResponse>("/api/set-lifecycle/distribute", {
        audio,
        logId,
        video,
      });
      openRun("set-lifecycle", runId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            <Broadcast aria-hidden data-icon="inline-start" />
            Distribute
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Distribute “{title}”</DialogTitle>
          <DialogDescription>
            <span className="font-display tabular-nums text-foreground">fluncle://{logId}</span>.
            Pushes the video to YouTube (unlisted until you publish it) and the audio master to
            Mixcloud. Pick at least one. Runs local-direct: the multi-GB push streams to the drawer.
          </DialogDescription>
        </DialogHeader>

        {masters === undefined ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="grid gap-3">
            <MasterPicker
              emptyLabel="No video masters in ~/Movies."
              label="Video → YouTube"
              onPick={(path) => setVideo((current) => (current === path ? undefined : path))}
              options={masters.videos}
              selected={video}
              withDuration
            />
            <MasterPicker
              emptyLabel="No audio masters in ~/Movies."
              label="Audio → Mixcloud"
              onPick={(path) => setAudio((current) => (current === path ? undefined : path))}
              options={masters.audios}
              selected={audio}
            />
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost">Cancel</Button>} />
          <Button disabled={busy || (!video && !audio)} onClick={() => void distribute()}>
            <Broadcast aria-hidden data-icon="inline-start" />
            {busy ? "Pushing…" : "Distribute"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MasterPicker({
  emptyLabel,
  label,
  onPick,
  options,
  selected,
  withDuration = false,
}: {
  emptyLabel: string;
  label: string;
  onPick: (path: string) => void;
  options: MovieEntry[];
  selected: string | undefined;
  withDuration?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="helm-scroll grid max-h-28 gap-1 overflow-y-auto">
          {options.map((option) => (
            <li key={option.path}>
              <button
                aria-current={selected === option.path ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left transition-colors",
                  selected === option.path
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => onPick(option.path)}
                type="button"
              >
                <span className="truncate text-sm text-foreground">{option.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[0.72rem]">
                  {formatBytes(option.sizeBytes)}
                  {withDuration && formatDuration(option.durationMs)
                    ? ` · ${formatDuration(option.durationMs)}`
                    : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
