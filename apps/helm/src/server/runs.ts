// The run registry — the action-streaming core (HELM-CONTRACT.md). Long-running
// operator actions run as daemon-spawned child processes; their stdout/stderr is
// line-buffered here and streamed to the UI over SSE. One action per runId; the
// registry holds status (running/ok/failed), the last N lines, kill support
// (SIGINT first, SIGKILL after a grace period), and — on daemon exit — an
// escalating, AWAITED stand-down: SIGINT the group, wait a bounded grace, SIGKILL
// the group, wait again, only then let the daemon go.
//
// Each run is spawned in its OWN PROCESS GROUP (Bun.spawn has no detached/setsid
// option — verified against current Bun docs — so a tiny perl setpgrp wrapper
// does it; macOS ships no setsid(1) but perl is always aboard). Kills target the
// group, so a child's grandchildren go down with it.
//
// Children get a LEAST-PRIVILEGE environment (child-env.ts): PATH/HOME/TMPDIR/
// LANG plus the caller's opts.env — never the daemon's own process.env, which
// the in-process admin bridge pollutes with the CLI token. A run that genuinely
// needs the admin credentials opts in with `adminToken: true`.
//
// Runs are feature-scoped: a run started by feature `show` answers only under
// /api/show/runs/<id>/…, so one feature can never stream or kill another's work.

import { existsSync } from "node:fs";

import { type RunLine, type RunStatus, type RunStream, type RunSummary } from "../contract";
import { childEnv } from "./child-env";
import { createLineSplitter } from "./lines";

/** The line buffer cap per run — old lines fall off the front, the log survives. */
const MAX_RUN_LINES = 2000;

/** Finished runs kept for the drawer's history before the oldest are pruned. */
const MAX_FINISHED_RUNS = 50;

export type RunTimings = {
  /** After the child exits, how long the output pumps get to drain before the run finalizes anyway. */
  drainGraceMs: number;
  /** How long a SIGINT'd child gets to wind down before the SIGKILL escalation (the kill route). */
  killGraceMs: number;
  /** Stand-down: the bounded wait after the group SIGINT. */
  standDownSigintGraceMs: number;
  /** Stand-down: the bounded wait after the group SIGKILL. */
  standDownSigkillGraceMs: number;
};

const DEFAULT_TIMINGS: RunTimings = {
  drainGraceMs: 5000,
  killGraceMs: 8000,
  standDownSigintGraceMs: 5000,
  standDownSigkillGraceMs: 2000,
};

// The process-group wrapper: perl setpgrp(0,0) then exec the real argv. perl is
// part of macOS; when it is missing (an unexpected box) the run spawns unwrapped
// and group kills fall back to the child alone.
const PERL_BIN = "/usr/bin/perl";
const SETPGRP_SOURCE = "setpgrp(0,0); exec @ARGV or die qq(helm group wrapper: exec failed: $!\\n)";

/** Pure: wrap argv so the child leads its own process group (when the wrapper exists). */
export function wrapInProcessGroup(argv: string[], wrapperAvailable: boolean): string[] {
  return wrapperAvailable ? [PERL_BIN, "-e", SETPGRP_SOURCE, "--", ...argv] : argv;
}

export type RunEvent = { kind: "line"; line: RunLine } | { kind: "status"; run: RunSummary };

export type RunListener = (event: RunEvent) => void;

export type RunStreamedOptions = {
  /**
   * Present the CLI's admin credentials to this child. Off by default — a child
   * runs tokenless unless its leg genuinely needs the token: the upload and
   * distribute legs spawn the `fluncle` CLI, and the Rekordbox derive/plan
   * scripts shell out to the `fluncle` CLI themselves, so those four opt in.
   */
  adminToken?: boolean;
  /** Working directory for the child (defaults to the daemon's own cwd). */
  cwd?: string;
  /** Extra environment on top of the minimal child base (never the daemon's process.env). */
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

export type RunRegistryDeps = {
  /** The CLI credentials for `adminToken: true` runs (admin.ts's adminChildEnv). */
  adminEnv?: () => Record<string, string | undefined>;
  /** Grace overrides — the tests inject short ones. */
  timings?: Partial<RunTimings>;
};

export type RunRegistry = {
  /** One run with its buffered lines, scoped to its owning feature. */
  get(feature: string, runId: string): Run | undefined;
  /** SIGINT the child's group (SIGKILL after the grace). False when there is no such run. */
  kill(feature: string, runId: string): boolean;
  /** Every run the daemon knows, newest first — the drawer's list. */
  list(): RunSummary[];
  /** Spawn argv and stream it. The contract's `runStreamed(argv, opts)`. */
  runStreamed(argv: string[], opts: RunStreamedOptions): { runId: string };
  /**
   * Daemon exit: SIGINT every running child's group, await a bounded grace,
   * SIGKILL the stragglers' groups, await again — resolves when it is safe to go.
   */
  standDown(): Promise<void>;
  /** Live events for one run; returns the unsubscribe. */
  subscribe(feature: string, runId: string, listener: RunListener): () => void;
};

/** True when the race's sleep won — the awaited thing did not settle in time. */
async function within(ms: number, awaited: Promise<unknown>): Promise<boolean> {
  return Promise.race([awaited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

export function createRunRegistry(deps: RunRegistryDeps = {}): RunRegistry {
  const timings: RunTimings = { ...DEFAULT_TIMINGS, ...deps.timings };
  const wrapperAvailable = existsSync(PERL_BIN);
  const runs = new Map<string, Run>();
  const children = new Map<string, Bun.Subprocess>();
  const killTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const settledByRun = new Map<string, Promise<void>>();
  const listeners = new Map<string, Set<RunListener>>();

  /** Signal the child's whole process group; fall back to the child alone. */
  function signal(child: Bun.Subprocess, sig: "SIGINT" | "SIGKILL"): void {
    try {
      process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  }

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
    // A pipe abandoned to grandchildren can trickle output after the run has
    // finalized — the log's last line stays the status narration.
    if (run.status !== "running" && stream !== "system") {
      return;
    }

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
      signal(child, "SIGINT");

      // The polite signal first; a group that ignores it gets the hard one.
      const timer = setTimeout(() => {
        if (run.status === "running") {
          pushLine(run, "system", "still up after the grace period — SIGKILL");
          signal(child, "SIGKILL");
        }
      }, timings.killGraceMs);
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

      const child = Bun.spawn(wrapInProcessGroup(argv, wrapperAvailable), {
        cwd: opts.cwd,
        env: childEnv({ adminEnv: deps.adminEnv, adminToken: opts.adminToken, extra: opts.env }),
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      });
      children.set(runId, child);

      const pumps = Promise.allSettled([
        pump(run, child.stdout, "stdout"),
        pump(run, child.stderr, "stderr"),
      ]);

      const settled = (async () => {
        const exitCode = await child.exited;
        // Let the pipes drain so the final lines land before the status does —
        // BOUNDED, because a grandchild that inherited the pipe can hold it
        // open forever after the child itself is gone.
        const drained = await within(timings.drainGraceMs, pumps);

        const timer = killTimers.get(runId);

        if (timer !== undefined) {
          clearTimeout(timer);
          killTimers.delete(runId);
        }

        if (!drained) {
          pushLine(run, "system", "(output pipe abandoned — grandchildren may hold it)");
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
        settledByRun.delete(runId);
        emit(runId, { kind: "status", run: summarize(run) });
        pruneFinished();
      })();
      settledByRun.set(runId, settled);
      void settled;

      return { runId };
    },

    async standDown() {
      const held = [...children.entries()];

      await Promise.all(
        held.map(async ([runId, child]) => {
          const run = runs.get(runId);

          if (run && run.status === "running") {
            run.killRequested = true;
            pushLine(run, "system", "daemon standing down (SIGINT)");
          }

          signal(child, "SIGINT");

          const settled = settledByRun.get(runId) ?? child.exited.then(() => undefined);

          if (await within(timings.standDownSigintGraceMs, settled)) {
            return;
          }

          if (run) {
            pushLine(run, "system", "still up after the grace — SIGKILL to the group");
          }

          signal(child, "SIGKILL");
          await within(timings.standDownSigkillGraceMs, settled);
        }),
      );
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
