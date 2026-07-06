// The run drawer — live output of any running action, docked under the panels.
// Collapsed it is one quiet summary row; expanded it lists the registry's runs
// and streams the selected one over SSE. Pre-flight tokens ([clear]/[hold]/[dark])
// render as status rows (the show.ts vocabulary); everything else is the raw
// monospace log. Voice: recovered terminal — deadpan, no traffic lights.

import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@fluncle/ui/components/button";
import { cn } from "@fluncle/ui/lib/utils";

import { type RunLine, type RunStatus, type RunSummary } from "../contract";
import { apiPost, streamRun } from "./api";
import { LogLine } from "./token-styles";

const STATUS_MARKS: Record<RunStatus, string> = {
  failed: "x",
  ok: "+",
  running: "…",
};

function elapsedLabel(run: RunSummary, now: number): string {
  const ms = (run.endedAt ?? now) - run.startedAt;
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

export type SelectedRun = {
  feature: string;
  runId: string;
};

type RunDrawerProps = {
  onSelect: (selected: SelectedRun | undefined) => void;
  onToggle: (open: boolean) => void;
  open: boolean;
  runs: RunSummary[];
  selected: SelectedRun | undefined;
};

export function RunDrawer({ onSelect, onToggle, open, runs, selected }: RunDrawerProps) {
  const running = runs.filter((run) => run.status === "running").length;
  const latest = runs[0];
  const selectedRun = runs.find((run) => run.id === selected?.runId);

  const summary =
    runs.length === 0
      ? "No runs logged yet. The log stays quiet."
      : running > 0
        ? `${running} running${latest ? ` · ${latest.title}` : ""}`
        : `${runs.length} logged${latest ? ` · last: ${latest.title}` : ""}`;

  return (
    <section aria-label="Runs" className="shrink-0 border-t bg-card/40">
      <button
        aria-controls="helm-run-drawer"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left transition-colors hover:bg-accent"
        onClick={() => onToggle(!open)}
        type="button"
      >
        <span className="flex items-baseline gap-3">
          <span className="text-xs font-extrabold text-foreground">Runs</span>
          <span className="text-xs text-muted-foreground">{summary}</span>
        </span>
        {open ? (
          <CaretDown aria-hidden className="size-4 text-muted-foreground" />
        ) : (
          <CaretUp aria-hidden className="size-4 text-muted-foreground" />
        )}
      </button>

      {open ? (
        <div
          className="grid h-[40dvh] grid-cols-[15rem_1fr] border-t max-md:grid-cols-1"
          id="helm-run-drawer"
        >
          <div className="helm-scroll overflow-y-auto border-r p-2 max-md:hidden">
            {runs.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                Nothing has run yet. Start an action on a station and it lands here.
              </p>
            ) : (
              <ul className="grid gap-0.5">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button
                      aria-current={run.id === selected?.runId ? "true" : undefined}
                      className={cn(
                        "grid w-full gap-0.5 rounded-md px-3 py-2 text-left transition-colors",
                        run.id === selected?.runId
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                      onClick={() => onSelect({ feature: run.feature, runId: run.id })}
                      type="button"
                    >
                      <span className="flex items-center gap-2 text-sm">
                        <span aria-hidden className="w-3 font-mono text-xs">
                          {STATUS_MARKS[run.status]}
                        </span>
                        <span className="truncate font-medium text-foreground">{run.title}</span>
                      </span>
                      <span className="pl-5 text-xs">
                        {run.feature} · {run.status}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {selected && selectedRun ? (
            <RunLogView key={selected.runId} run={selectedRun} selected={selected} />
          ) : (
            <div className="grid place-items-center p-6">
              <p className="text-sm text-muted-foreground">
                {runs.length === 0
                  ? "The log stays quiet until something runs."
                  : "Pick a run to read its log."}
              </p>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

type RunLogViewProps = {
  run: RunSummary;
  selected: SelectedRun;
};

function RunLogView({ run, selected }: RunLogViewProps) {
  const [lines, setLines] = useState<RunLine[]>([]);
  const [live, setLive] = useState<RunSummary>(run);
  const [standingDown, setStandingDown] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    setLines([]);

    return streamRun(selected.feature, selected.runId, {
      onLine(line) {
        setLines((prev) => [...prev, line]);
      },
      onStatus(summary) {
        setLive(summary);
      },
    });
  }, [selected.feature, selected.runId]);

  // The elapsed clock ticks only while the run does.
  useEffect(() => {
    if (live.status !== "running") {
      return;
    }

    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [live.status]);

  // Follow the tail unless the operator scrolled up to read.
  useEffect(() => {
    const el = logRef.current;

    if (el && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  async function standDown(): Promise<void> {
    setStandingDown(true);

    try {
      await apiPost(`/api/${selected.feature}/runs/${selected.runId}/kill`);
    } catch {
      setStandingDown(false);
    }
  }

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr]">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="truncate text-sm font-extrabold text-foreground">{live.title}</span>
          <span className="text-xs text-muted-foreground">
            {live.feature} · {live.status} ·{" "}
            <span className="tabular-nums">{elapsedLabel(live, now)}</span>
          </span>
        </div>
        {live.status === "running" ? (
          <Button
            disabled={standingDown}
            onClick={() => void standDown()}
            size="xs"
            variant="destructive"
          >
            {standingDown ? "Standing down…" : "Stand down"}
          </Button>
        ) : null}
      </div>

      <div
        className="helm-scroll min-h-0 overflow-y-auto px-4 py-3 font-mono text-[0.82rem] leading-normal"
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
