// The run registry — the action-streaming core (HELM-CONTRACT.md). Long-running
// operator actions run as daemon-spawned child processes; their stdout/stderr is
// line-buffered here and streamed to the UI over SSE. One action per runId; the
// registry holds status (running/ok/failed), the last N lines, kill support
// (SIGINT first, SIGKILL after a grace period), and stands every child down when
// the daemon itself exits.
//
// Runs are feature-scoped: a run started by feature `show` answers only under
// /api/show/runs/<id>/…, so one feature can never stream or kill another's work.

import { type RunLine, type RunStatus, type RunStream, type RunSummary } from "../contract";
import { createLineSplitter } from "./lines";

/** The line buffer cap per run — old lines fall off the front, the log survives. */
const MAX_RUN_LINES = 2000;

/** Finished runs kept for the drawer's history before the oldest are pruned. */
const MAX_FINISHED_RUNS = 50;

/** How long a SIGINT'd child gets to wind down before the SIGKILL escalation. */
const KILL_GRACE_MS = 8000;

export type RunEvent = { kind: "line"; line: RunLine } | { kind: "status"; run: RunSummary };

export type RunListener = (event: RunEvent) => void;

export type RunStreamedOptions = {
  /** Working directory for the child (defaults to the daemon's own cwd). */
  cwd?: string;
  /** Extra environment on top of the daemon's own. */
  env?: Record<string, string | undefined>;
  /** The owning feature id — scopes the run's stream/kill routes. */
  feature: string;
  /** What the drawer calls this run ("upload recording", "line check"). */
  title: string;
};

export type Run = {
  argv: string[];
  endedAt: number | null;
  exitCode: number | null;
  feature: string;
  id: string;
  killRequested: boolean;
  lines: RunLine[];
  startedAt: number;
  status: RunStatus;
  title: string;
};

export type RunRegistry = {
  /** One run with its buffered lines, scoped to its owning feature. */
  get(feature: string, runId: string): Run | undefined;
  /** SIGINT the child (SIGKILL after the grace). False when there is no such run. */
  kill(feature: string, runId: string): boolean;
  /** Every run the daemon knows, newest first — the drawer's list. */
  list(): RunSummary[];
  /** Spawn argv and stream it. The contract's `runStreamed(argv, opts)`. */
  runStreamed(argv: string[], opts: RunStreamedOptions): { runId: string };
  /** SIGINT every running child — called once, on daemon exit. */
  standDown(): void;
  /** Live events for one run; returns the unsubscribe. */
  subscribe(feature: string, runId: string, listener: RunListener): () => void;
};

export function createRunRegistry(): RunRegistry {
  const runs = new Map<string, Run>();
  const children = new Map<string, Bun.Subprocess>();
  const killTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Map<string, Set<RunListener>>();

  function summarize(run: Run): RunSummary {
    return {
      argv: run.argv,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      feature: run.feature,
      id: run.id,
      startedAt: run.startedAt,
      status: run.status,
      title: run.title,
    };
  }

  function emit(runId: string, event: RunEvent): void {
    const subs = listeners.get(runId);

    if (!subs) {
      return;
    }

    for (const listener of subs) {
      listener(event);
    }
  }

  function pushLine(run: Run, stream: RunStream, text: string): void {
    const line: RunLine = { seq: nextSeq(run), stream, text };
    run.lines.push(line);

    if (run.lines.length > MAX_RUN_LINES) {
      run.lines.splice(0, run.lines.length - MAX_RUN_LINES);
    }

    emit(run.id, { kind: "line", line });
  }

  function nextSeq(run: Run): number {
    const last = run.lines.at(-1);

    return last === undefined ? 0 : last.seq + 1;
  }

  /** Drain one std stream into the run's line buffer. */
  async function pump(
    run: Run,
    stream: ReadableStream<Uint8Array>,
    name: Exclude<RunStream, "system">,
  ): Promise<void> {
    const splitter = createLineSplitter();
    const decoder = new TextDecoder();

    for await (const chunk of stream) {
      for (const text of splitter.push(decoder.decode(chunk, { stream: true }))) {
        pushLine(run, name, text);
      }
    }

    const tail = splitter.flush();

    if (tail !== undefined) {
      pushLine(run, name, tail);
    }
  }

  /** Drop the oldest finished runs beyond the history cap (running runs never). */
  function pruneFinished(): void {
    const finished = [...runs.values()]
      .filter((run) => run.status !== "running")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));

    for (const run of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_RUNS))) {
      runs.delete(run.id);
      listeners.delete(run.id);
    }
  }

  return {
    get(feature, runId) {
      const run = runs.get(runId);

      return run && run.feature === feature ? run : undefined;
    },

    kill(feature, runId) {
      const run = runs.get(runId);
      const child = children.get(runId);

      if (!run || run.feature !== feature || !child || run.status !== "running") {
        return false;
      }

      run.killRequested = true;
      pushLine(run, "system", "standing down (SIGINT)");
      child.kill("SIGINT");

      // The polite signal first; a child that ignores it gets the hard one.
      const timer = setTimeout(() => {
        if (run.status === "running") {
          pushLine(run, "system", "still up after the grace period — SIGKILL");
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
      timer.unref();
      killTimers.set(runId, timer);

      return true;
    },

    list() {
      return [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((run) => summarize(run));
    },

    runStreamed(argv, opts) {
      const runId = crypto.randomUUID();
      const run: Run = {
        argv,
        endedAt: null,
        exitCode: null,
        feature: opts.feature,
        id: runId,
        killRequested: false,
        lines: [],
        startedAt: Date.now(),
        status: "running",
        title: opts.title,
      };
      runs.set(runId, run);

      const child = Bun.spawn(argv, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      });
      children.set(runId, child);

      const pumps = Promise.allSettled([
        pump(run, child.stdout, "stdout"),
        pump(run, child.stderr, "stderr"),
      ]);

      void (async () => {
        const exitCode = await child.exited;
        // Let the pipes drain fully so the final lines land before the status does.
        await pumps;

        const timer = killTimers.get(runId);

        if (timer !== undefined) {
          clearTimeout(timer);
          killTimers.delete(runId);
        }

        run.endedAt = Date.now();
        run.exitCode = exitCode;
        run.status = exitCode === 0 ? "ok" : "failed";
        pushLine(
          run,
          "system",
          run.killRequested
            ? `stood down (exit ${exitCode})`
            : exitCode === 0
              ? "done (exit 0)"
              : `failed (exit ${exitCode})`,
        );
        children.delete(runId);
        emit(runId, { kind: "status", run: summarize(run) });
        pruneFinished();
      })();

      return { runId };
    },

    standDown() {
      for (const [runId, child] of children) {
        const run = runs.get(runId);

        if (run && run.status === "running") {
          run.killRequested = true;
        }

        child.kill("SIGINT");
      }
    },

    subscribe(feature, runId, listener) {
      const run = runs.get(runId);

      if (!run || run.feature !== feature) {
        return () => {};
      }

      const subs = listeners.get(runId) ?? new Set<RunListener>();
      subs.add(listener);
      listeners.set(runId, subs);

      return () => {
        subs.delete(listener);
      };
    },
  };
}
