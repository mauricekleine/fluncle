// The show-control panel — raise the live glass from the Helm, and read the show's
// pre-flight back as a signature checklist. The picker lists the raisable tracklists
// (plans by handle, mixtapes by Log ID); "Raise the glass" spawns the show under the
// daemon; the pre-flight tokens ([clear]/[hold]/[dark], packages/live/src/show.ts)
// fold into a live checklist, holds surface a "depart anyway" re-run, and once the
// glass is up the quick links appear. Reload-honest: it re-attaches to the running
// (or most recent) show run, and refuses a second — the glass ports are singular.
//
// Voice: a recovered terminal (VOICE.md, CLI register) — deadpan machine states,
// never a traffic light. Gold is the one light (DESIGN.md, The One Sun Rule): the
// Raise button, and the "glass is up" moment.

import { ArrowSquareOut, ArrowsClockwise, Broadcast, Stop, Warning } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@fluncle/ui/components/button";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import { cn } from "@fluncle/ui/lib/utils";

import { type RunLine, type RunStatus, type RunSummary } from "../../contract";
import { ApiError, apiGet, apiPost, streamRun } from "../../ui/api";
import { parseStatusLine } from "../../ui/status-line";
import { type ShowChoice, type ShowChoiceKind } from "./choices";
import {
  checkByLabel,
  EXPECTED_CHECKS,
  parseNamedCheck,
  type ShowPhase,
  readShowProgress,
} from "./preflight";
import { type ActiveResponse, type ChoicesResponse, type ShowLinks, SHOW_FEATURE_ID } from "./wire";
import { type RunStartedResponse } from "../../contract";

const ACTIVE_POLL_MS = 5000;
const CHOICES_POLL_MS = 30_000;

const GROUP_LABEL: Record<ShowChoiceKind, string> = {
  mixtape: "Mixtapes",
  plan: "Plans",
  take: "Takes",
};

const TOKEN_STYLES = {
  clear: "font-bold text-foreground",
  dark: "text-muted-foreground",
  hold: "font-bold text-destructive",
} as const;

function shortDate(iso: string | null): string {
  if (iso === null) {
    return "—";
  }

  const ms = Date.parse(iso);

  if (!Number.isFinite(ms)) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(ms);
}

/** The plan ref a run was raised on, read back off its title (survives a reload). */
function refFromTitle(title: string): string {
  return title
    .replace(/^raise the glass — /, "")
    .replace(/ \((forced)\)$/, "")
    .trim();
}

export default function ShowControlPanel() {
  const [choices, setChoices] = useState<ChoicesResponse | undefined>(undefined);
  const [selectedRef, setSelectedRef] = useState<string | undefined>(undefined);
  const [activeRun, setActiveRun] = useState<RunSummary | null>(null);
  const [links, setLinks] = useState<ShowLinks>({ glass: "http://localhost:4173", remote: null });
  const [lines, setLines] = useState<RunLine[]>([]);
  const [runStatus, setRunStatus] = useState<RunStatus | undefined>(undefined);
  const [raising, setRaising] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);

  const activeRunId = activeRun?.id;
  const runningShow = activeRun !== null && runStatus === "running";

  const refreshActive = useCallback(async (): Promise<RunSummary | null> => {
    try {
      const response = await apiGet<ActiveResponse>("/api/show-control/active");
      setActiveRun(response.run);
      setLinks(response.links);
      // Seed the run's status here (not inside the stream effect) so that effect can key
      // on the run IDENTITY alone — a status tick must never tear down the SSE stream.
      setRunStatus(response.run?.status);

      return response.run;
    } catch {
      return null;
    }
  }, []);

  const refreshChoices = useCallback(async () => {
    try {
      setChoices(await apiGet<ChoicesResponse>("/api/show-control/choices"));
    } catch {
      setChoices({ choices: [], ok: true, reachable: false });
    }
  }, []);

  // First read: the pickable tracklists + any show already up (reload re-attach).
  useEffect(() => {
    void refreshChoices();
    void refreshActive();
  }, [refreshActive, refreshChoices]);

  // Poll the active run so a show started/stood-down elsewhere still reflects here.
  useEffect(() => {
    const timer = setInterval(() => void refreshActive(), ACTIVE_POLL_MS);

    return () => clearInterval(timer);
  }, [refreshActive]);

  // Keep the picker fresh (a plan authored in /admin/plans shows up) — but only when no
  // show is up, so a live raise never re-hits the admin API mid-set.
  useEffect(() => {
    if (runningShow) {
      return;
    }

    const timer = setInterval(() => void refreshChoices(), CHOICES_POLL_MS);

    return () => clearInterval(timer);
  }, [refreshChoices, runningShow]);

  // Stream the active run: replay its buffered lines, then live. Keyed on the run
  // IDENTITY only (its status is seeded by refreshActive), so a status tick never
  // re-subscribes; the seq-keyed lines feed the checklist reducer.
  useEffect(() => {
    setLines([]);

    if (activeRunId === undefined) {
      return;
    }

    return streamRun(SHOW_FEATURE_ID, activeRunId, {
      onLine(line) {
        setLines((prev) => [...prev, line]);
      },
      onStatus(summary) {
        setRunStatus(summary.status);
      },
    });
  }, [activeRunId]);

  async function raise(ref: string, force: boolean): Promise<void> {
    setRaising(true);
    setNote(undefined);

    try {
      const started = await apiPost<RunStartedResponse>("/api/show-control/raise", { force, ref });
      const run = await refreshActive();

      // refreshActive normally returns the just-started run; the placeholder is a safety
      // net for the rare poll-race so the panel attaches to the stream immediately.
      if (run === null) {
        setActiveRun(placeholderRun(started.runId, ref));
        setRunStatus("running");
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "already_running") {
        setNote("A show is already up. Stand it down before raising another.");
        await refreshActive();
      } else if (error instanceof ApiError) {
        setNote(error.message);
      } else {
        setNote("The daemon didn't take the raise.");
      }
    } finally {
      setRaising(false);
    }
  }

  async function standDown(): Promise<void> {
    if (activeRunId === undefined) {
      return;
    }

    try {
      await apiPost(`/api/${SHOW_FEATURE_ID}/runs/${activeRunId}/kill`);
      await refreshActive();
    } catch {
      setNote("Stand-down didn't land — the run may have already ended.");
    }
  }

  const progress = readShowProgress(lines.map((line) => line.text));
  const runEnded = runStatus !== undefined && runStatus !== "running";
  const canDepartAnyway = activeRun !== null && runEnded && progress.phase === "holding";

  return (
    <div className="grid max-w-2xl gap-6">
      <header className="grid gap-1">
        <h2 className="text-base font-extrabold text-foreground">Show</h2>
        <p className="text-sm text-muted-foreground">
          Raise the glass. The rig comes up in order; the pre-flight reads back here.
        </p>
      </header>

      {runningShow ? (
        <RunningBanner run={activeRun} />
      ) : (
        <RaiseZone
          choices={choices}
          onRaise={(ref) => void raise(ref, false)}
          onRefresh={() => void refreshChoices()}
          onSelect={setSelectedRef}
          raising={raising}
          selectedRef={selectedRef}
        />
      )}

      {note ? (
        <p aria-live="polite" className="text-xs text-destructive">
          {note}
        </p>
      ) : null}

      {activeRun !== null ? (
        <SignaturePanel
          canDepartAnyway={canDepartAnyway}
          lines={lines}
          links={links}
          onDepartAnyway={() => void raise(refFromTitle(activeRun.title), true)}
          onStandDown={() => void standDown()}
          progress={progress}
          raising={raising}
          run={activeRun}
          running={runningShow}
        />
      ) : null}
    </div>
  );
}

function placeholderRun(id: string, ref: string): RunSummary {
  return {
    argv: [],
    endedAt: null,
    exitCode: null,
    feature: SHOW_FEATURE_ID,
    id,
    startedAt: Date.now(),
    status: "running",
    title: `raise the glass — ${ref}`,
  };
}

// ── The picker + raise ─────────────────────────────────────────────────────────

type RaiseZoneProps = {
  choices: ChoicesResponse | undefined;
  onRaise: (ref: string) => void;
  onRefresh: () => void;
  onSelect: (ref: string) => void;
  raising: boolean;
  selectedRef: string | undefined;
};

function RaiseZone({
  choices,
  onRaise,
  onRefresh,
  onSelect,
  raising,
  selectedRef,
}: RaiseZoneProps) {
  return (
    <section aria-label="Tracklists" className="grid gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-extrabold tracking-wide text-muted-foreground uppercase">
          Tracklist
        </h3>
        <Button onClick={onRefresh} size="xs" variant="ghost">
          <ArrowsClockwise aria-hidden data-icon="inline-start" />
          Refresh
        </Button>
      </div>

      <div className="rounded-lg border bg-card/40 p-1.5">
        <Picker choices={choices} onSelect={onSelect} selectedRef={selectedRef} />
      </div>

      <div className="flex items-center gap-3">
        <Button
          disabled={selectedRef === undefined || raising}
          onClick={() => selectedRef !== undefined && onRaise(selectedRef)}
        >
          <Broadcast aria-hidden data-icon="inline-start" weight="fill" />
          {raising ? "Raising…" : "Raise the glass"}
        </Button>
        {selectedRef !== undefined ? (
          <span className="font-mono text-xs text-muted-foreground">--plan {selectedRef}</span>
        ) : null}
      </div>
    </section>
  );
}

function Picker({
  choices,
  onSelect,
  selectedRef,
}: {
  choices: ChoicesResponse | undefined;
  onSelect: (ref: string) => void;
  selectedRef: string | undefined;
}) {
  if (choices === undefined) {
    return (
      <div className="grid gap-1.5 p-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    );
  }

  if (!choices.reachable) {
    return (
      <PickerEmpty
        label="admin"
        note="the admin API didn't answer — is the token aboard? (~/.config/fluncle)"
      />
    );
  }

  if (choices.choices.length === 0) {
    return (
      <PickerEmpty label="plans" note="no plans or mixtapes yet — author one in /admin/plans" />
    );
  }

  return (
    <ul className="grid gap-0.5">
      {choices.choices.map((choice, index) => {
        const previous = choices.choices[index - 1];
        const heading = previous === undefined || previous.kind !== choice.kind;

        return (
          <li key={`${choice.kind}:${choice.ref}`}>
            {heading ? (
              <p className="px-3 pt-2 pb-1 text-[0.68rem] font-bold tracking-wide text-muted-foreground/70 uppercase">
                {GROUP_LABEL[choice.kind]}
              </p>
            ) : null}
            <ChoiceRow choice={choice} onSelect={onSelect} selected={choice.ref === selectedRef} />
          </li>
        );
      })}
    </ul>
  );
}

function PickerEmpty({ label, note }: { label: string; note: string }) {
  return (
    <p className="flex gap-3 px-3 py-3 font-mono text-[0.82rem]">
      <span className="text-muted-foreground">[dark]</span>
      <span className="text-foreground">{label}</span>
      <span className="text-muted-foreground">{note}</span>
    </p>
  );
}

function ChoiceRow({
  choice,
  onSelect,
  selected,
}: {
  choice: ShowChoice;
  onSelect: (ref: string) => void;
  selected: boolean;
}) {
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid w-full gap-0.5 rounded-md px-3 py-2 text-left transition-colors",
        selected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
      onClick={() => onSelect(choice.ref)}
      type="button"
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="truncate font-mono text-xs text-foreground">{choice.handle}</span>
        <span className="shrink-0 text-[0.7rem] text-muted-foreground">
          {choice.countLabel} · {shortDate(choice.recordedAt)}
        </span>
      </span>
      {choice.title !== choice.handle ? (
        <span className="truncate text-xs">{choice.title}</span>
      ) : null}
    </button>
  );
}

// ── The signature panel: checklist + links + log ───────────────────────────────

type SignaturePanelProps = {
  canDepartAnyway: boolean;
  lines: RunLine[];
  links: ShowLinks;
  onDepartAnyway: () => void;
  onStandDown: () => void;
  progress: ReturnType<typeof readShowProgress>;
  raising: boolean;
  run: RunSummary;
  running: boolean;
};

function SignaturePanel({
  canDepartAnyway,
  lines,
  links,
  onDepartAnyway,
  onStandDown,
  progress,
  raising,
  run,
  running,
}: SignaturePanelProps) {
  const logLines = lines.filter((line) => parseNamedCheck(line.text) === undefined);

  return (
    <section aria-label="Pre-flight" className="grid gap-4 rounded-lg border bg-card/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PhaseBanner phase={progress.phase} />
        <div className="flex items-center gap-2">
          {canDepartAnyway ? (
            <Button disabled={raising} onClick={onDepartAnyway} size="sm" variant="outline">
              <Warning aria-hidden data-icon="inline-start" />
              Depart anyway
            </Button>
          ) : null}
          {running ? (
            <Button onClick={onStandDown} size="sm" variant="destructive">
              <Stop aria-hidden data-icon="inline-start" />
              Stand down
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="grid gap-1.5 font-mono text-[0.82rem] leading-relaxed">
        {EXPECTED_CHECKS.map((label) => (
          <CheckRow
            check={checkByLabel(progress, label)}
            ended={!running && progress.phase !== "idle"}
            key={label}
            label={label}
          />
        ))}
      </dl>

      {progress.phase === "live" ? (
        <LiveLinks bridgeLive={progress.bridgeLive} links={links} />
      ) : null}

      <RunLog lines={logLines} title={run.title} />
    </section>
  );
}

const PHASE_COPY: Record<ShowPhase, { note: string; tone: "gold" | "hold" | "quiet" }> = {
  clear: { note: "clear to depart", tone: "quiet" },
  down: { note: "stood down — the glass is dark", tone: "quiet" },
  holding: { note: "holding — the rig is not clear to depart", tone: "hold" },
  idle: { note: "waiting on the first line", tone: "quiet" },
  live: { note: "the glass is up", tone: "gold" },
  reading: { note: "reading the rig…", tone: "quiet" },
};

function PhaseBanner({ phase }: { phase: ShowPhase }) {
  const { note, tone } = PHASE_COPY[phase];

  return (
    <p
      className={cn(
        "flex items-center gap-2 font-mono text-sm font-bold",
        tone === "gold" ? "text-primary" : tone === "hold" ? "text-destructive" : "text-foreground",
      )}
    >
      {phase === "live" ? <Broadcast aria-hidden className="size-4" weight="fill" /> : null}
      {note}
    </p>
  );
}

function CheckRow({
  check,
  ended,
  label,
}: {
  check: ReturnType<typeof checkByLabel>;
  ended: boolean;
  label: string;
}) {
  const token = check?.token;
  const pendingNote = ended ? "not reached" : "…";

  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className={cn("w-14 shrink-0", token ? TOKEN_STYLES[token] : "text-muted-foreground/50")}
      >
        {token ? `[${token}]` : "[ · ]"}
      </span>
      <dt className="w-28 shrink-0 text-foreground">{label}</dt>
      <dd className={cn(check ? "text-muted-foreground" : "text-muted-foreground/50")}>
        {check?.note ?? pendingNote}
      </dd>
    </div>
  );
}

function LiveLinks({ bridgeLive, links }: { bridgeLive: boolean; links: ShowLinks }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
        href={links.glass}
        rel="noreferrer"
        target="_blank"
      >
        <ArrowSquareOut aria-hidden data-icon="inline-start" />
        Open the glass
      </a>
      {links.remote !== null ? (
        <a
          className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
          href={links.remote}
          rel="noreferrer"
          target="_blank"
        >
          <ArrowSquareOut aria-hidden data-icon="inline-start" />
          Phone remote
        </a>
      ) : (
        <span className="font-mono text-xs text-muted-foreground/70">
          no LAN address — the phone remote wants FLUNCLE_HELM_LAN=1
        </span>
      )}
      {links.remote !== null && !bridgeLive ? (
        <span className="font-mono text-xs text-muted-foreground/70">
          (the bridge socket hasn&rsquo;t answered yet)
        </span>
      ) : null}
    </div>
  );
}

function RunLog({ lines, title }: { lines: RunLine[]; title: string }) {
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = logRef.current;

    if (el && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="grid gap-1.5">
      <p className="font-mono text-[0.7rem] tracking-wide text-muted-foreground/70">{title}</p>
      <div
        className="helm-scroll max-h-56 overflow-y-auto rounded-md border bg-background/40 px-3 py-2 font-mono text-[0.78rem] leading-normal"
        onScroll={() => {
          const el = logRef.current;

          if (el) {
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }
        }}
        ref={logRef}
        role="log"
      >
        {lines.length === 0 ? (
          <p className="text-muted-foreground">No output yet. The line holds.</p>
        ) : (
          lines.map((line) => <LogLine key={line.seq} line={line} />)
        )}
      </div>
    </div>
  );
}

function LogLine({ line }: { line: RunLine }) {
  const row = line.stream === "system" ? undefined : parseStatusLine(line.text);

  if (row) {
    return (
      <div className="flex gap-3 whitespace-pre-wrap">
        <span className={TOKEN_STYLES[row.token]}>[{row.token}]</span>
        <span className="text-foreground">{row.label}</span>
        {row.note ? <span className="text-muted-foreground">{row.note}</span> : null}
      </div>
    );
  }

  if (line.stream === "system") {
    return <div className="whitespace-pre-wrap text-muted-foreground">— {line.text}</div>;
  }

  return <div className="whitespace-pre-wrap text-foreground/90">{line.text}</div>;
}

function RunningBanner({ run }: { run: RunSummary }) {
  return (
    <section
      aria-label="A show is up"
      className="flex items-center gap-3 rounded-lg border border-primary/30 bg-[var(--gold-veil)] px-4 py-3"
    >
      <Broadcast aria-hidden className="size-4 text-primary" weight="fill" />
      <div className="grid">
        <span className="text-sm font-bold text-foreground">A show is up.</span>
        <span className="font-mono text-xs text-muted-foreground">{run.title}</span>
      </div>
    </section>
  );
}
