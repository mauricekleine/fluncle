#!/usr/bin/env bun
// reconcile-hub-counts.ts — the bun orchestrator behind the HUB-COUNTS RECONCILIATION cron
// (`fluncle-reconcile-hub-counts`), scheduled by a rave-02 HOST systemd timer
// (../reconcile-hub-counts-timer/).
//
// WHY THIS EXISTS. `labels`, `albums` and `artists` each carry `renderable_track_count` +
// `certified_finding_count`, maintained as DELTAS by every edge-writing path — because
// recompute-from-truth measured 27,400 ms at 150k hosted against ~200 ms for the delta form
// (docs/db-scale-backlog Wave 2 keystone 2). That trade takes on one debt: a maintained counter
// DRIFTS, silently. Three ways, none of them fixable from inside the write side — a missed write
// path, a non-atomic bulk op, or an OUT-OF-BAND write (the operator's catalogue-prune skill
// deletes tracks straight out of the database; no server-side track-delete path exists at all).
//
// THE AUDIT TRAIL IS THE POINT. A non-zero `corrected` is a SIGNAL, not noise — it means a write
// path is leaking. So the tick logs the per-table numbers on every run and journalctl on the box
// holds the history:
//
//   [reconcile-hub-counts] AUDIT corrected=48 labels=1 albums=3 artists=44 tookMs=1150 deferred=0
//
// and the machine-readable last stdout line (also the /status prober's run output).
//
// Read the history with:  journalctl -u fluncle-reconcile-hub-counts.service | grep AUDIT
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (reconcile-hub-counts.sh) the host
// timer docker-execs — see that file's header for the wire-up and
// ../reconcile-hub-counts-timer/README.md for the operator runbook.
//
// ── THE TICK ───────────────────────────────────────────────────────────────────────────────────
//   The pass is a chain of bounded WINDOWS. Each window is one POST
//   /api/v1/admin/hub-counts/reconcile with the box's AGENT token and a body of
//   `{ cursor, pageLimit }`: the Worker reads at most `WINDOW_PAGE_LIMIT` keyset pages of entity
//   rows (each page's truth is one bounded read by the entity's own index), writes only the rows
//   that disagree as guarded point writes, and returns the per-table counts plus `next`, the cursor
//   the following window resumes from (null once labels, albums and artists are all done).
//
//   Every window runs in its own admitted database phase (`database-admission-runner.sh phase`), so
//   the admission lease is held only while one window runs and every other admitted writer, and the
//   public-latency guardrails, get their turn between windows. A yielded acquisition is retried
//   once (`WINDOW_YIELD_RETRIES`, the registry's replay-safe-idempotent disposition: a window
//   re-read from its cursor rewrites only rows that still disagree); a second yield stops the run
//   as paused backpressure, and the next night starts again from the first label.
//
//   An inherited whole-lifetime runner (`FLUNCLE_ADMISSION_RUNNER_PID`, exported by an installed
//   unit that still wraps this script in database-admission-runner.sh) already holds the lease for
//   the whole process, so the same windows then run in-process without nesting phase admission.
//   A Worker that predates windows answers the first call with a full pass and no `next`; the tick
//   reads that as a completed pass.
//
// THE BOX DEPENDS ON NO NEW CLI COMMAND. The baked `fluncle` CLI is a PINNED release, so this
// sweep calls the oRPC HTTP endpoint DIRECTLY with the agent token (the funnel-snapshot /
// anchor-sweep precedent), never a `fluncle admin …` subcommand a pin might not carry. No new
// secret either — every statement runs Worker-side.
//
// The tick is exported + unit-tested in reconcile-hub-counts.test.ts with its window effect
// injected; `main()` is guarded behind `import.meta.main` so importing this module for the tests
// is side-effect free (no network).
//
// stdout: one JSON summary line (the cron run output); a window child prints one JSON envelope
// instead. Diagnostics → stderr.

import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the secrets on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
const ADMISSION_OWNER = "fluncle-reconcile-hub-counts";

/** Keyset pages per window. A page is at most 250 entity rows, so a window stays a few seconds. */
export const WINDOW_PAGE_LIMIT = 8;
/** A yielded window acquisition is retried once; the registry pins the same value. */
export const WINDOW_YIELD_RETRIES = 1;
/** New windows start only inside this wall budget, leaving the unit timeout room for the last. */
export const WINDOW_START_BUDGET_MS = 600_000;
/** A cursor chain can never hold the unit forever: the pass stops starting windows here. */
export const MAX_WINDOWS = 200;
/** One window request's ceiling. */
const WINDOW_TIMEOUT_MS = 120_000;

const log = (message: string) => console.error(`[reconcile-hub-counts] ${message}`);

// ── Types — only the fields we consume from the op ────────────────────────────

export const RECONCILE_TABLES = ["labels", "albums", "artists"] as const;
export type ReconcileTable = (typeof RECONCILE_TABLES)[number];

/** Where the next window resumes, exactly as the op returns it. */
export type ReconcileCursor = { afterId: null | string; table: ReconcileTable };

/** One table's outcome as the op returns it (an object, so it can grow). */
export type ReconcileTableResult = { corrected?: number; deferred?: number };

/** What `reconcile_hub_counts` returns. A Worker without windows sends no `next`. */
export type ReconcileHubCountsResponse = {
  albums?: ReconcileTableResult;
  artists?: ReconcileTableResult;
  labels?: ReconcileTableResult;
  next?: ReconcileCursor | null;
  ok?: boolean;
  pages?: number;
  tookMs?: number;
};

/** One tick's honest summary — the JSON line the /status prober reads, and the drift audit. */
// Deliberately no `queue_depth`: the endpoint returns rows corrected during the pass, not an
// independently measured count of drift remaining after it, so zero would be an assumption.
export type ReconcileHubCountsSummary = {
  admissionOutcome?: string;
  albums: null | number;
  artists: null | number;
  /** Entity tables the tick reconciled completely. */
  checked: number;
  /** The three tables' corrected rows added up — null unless every table was read completely. */
  corrected: null | number;
  /** Drifted rows the Worker left for the next pass because a concurrent delta kept moving them. */
  deferred: null | number;
  error: null | string;
  /** Run-level failures. Per-table drift remains in the domain counters below. */
  errors: number;
  gateState?: string;
  labels: null | number;
  ok: boolean;
  /** True when the pass stopped before every table was reconciled. */
  partial: boolean;
  /** Rows the reconciliation actually corrected; null when the tick could not read a result. */
  produced: null | number;
  reason: null | string;
  throttled?: boolean;
  /** Server-side wall clock summed over every window (distinct from the tick's own elapsedMs). */
  tookMs: null | number;
  /** Windows whose response the tick read. */
  windows: number;
};

/**
 * The injected effects — so the tick's outcome mapping is provable with a stub (no network).
 * `reconcile` runs one window from `cursor` (null for the first) and resolves `undefined` when its
 * admitted phase yielded without a result.
 */
export type ReconcileHubCountsDeps = {
  log: (message: string) => void;
  now?: () => number;
  reconcile: (cursor: ReconcileCursor | null) => Promise<ReconcileHubCountsResponse | undefined>;
};

/** Per-table running totals; null until the pass reaches that table. */
type Totals = Record<ReconcileTable, null | { corrected: number; deferred: number }>;

/** How the window walk ended and what it read. */
type Walk = {
  cursor: ReconcileCursor | null;
  error: null | string;
  legacy: boolean;
  reason: null | string;
  stop: "complete" | "failed" | "partial" | "yielded";
  tookMs: null | number;
  windows: number;
};

/** Read one table's `corrected`, tolerating a field the op did not send. */
function correctedOf(table: ReconcileTableResult | undefined): null | number {
  return typeof table?.corrected === "number" ? table.corrected : null;
}

function deferredOf(table: ReconcileTableResult | undefined): number {
  return typeof table?.deferred === "number" ? table.deferred : 0;
}

/** Validate a cursor from the op (or the window child's argv). */
export function parseReconcileCursor(value: unknown): ReconcileCursor | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reconcile_hub_counts returned an invalid cursor");
  }
  const candidate = value as Record<string, unknown>;
  const table = RECONCILE_TABLES.find((name) => name === candidate.table);
  const afterId = candidate.afterId;
  if (
    table === undefined ||
    (afterId !== null && (typeof afterId !== "string" || afterId === ""))
  ) {
    throw new Error("reconcile_hub_counts returned an invalid cursor");
  }

  return { afterId, table };
}

/** The request body for one window. */
export function windowBody(cursor: ReconcileCursor | null): {
  cursor?: ReconcileCursor;
  pageLimit: number;
} {
  return cursor === null
    ? { pageLimit: WINDOW_PAGE_LIMIT }
    : { cursor, pageLimit: WINDOW_PAGE_LIMIT };
}

/** A Worker without windows ran the whole pass in one call; read whatever tables it reported. */
function foldLegacyResponse(totals: Totals, response: ReconcileHubCountsResponse): void {
  for (const table of RECONCILE_TABLES) {
    const corrected = correctedOf(response[table]);
    if (corrected !== null) {
      totals[table] = { corrected, deferred: deferredOf(response[table]) };
    }
  }
}

/**
 * Fold one window into the running totals and return its validated `next`. The window covers the
 * tables from its starting cursor through the table `next` stops in; a `next` at the very start of
 * a table means that table has not been reached yet.
 */
function foldWindowResponse(
  totals: Totals,
  cursor: ReconcileCursor | null,
  response: ReconcileHubCountsResponse,
): ReconcileCursor | null {
  const next = parseReconcileCursor(response.next);
  const firstIndex = cursor === null ? 0 : RECONCILE_TABLES.indexOf(cursor.table);
  const lastIndex =
    next === null
      ? RECONCILE_TABLES.length - 1
      : RECONCILE_TABLES.indexOf(next.table) - (next.afterId === null ? 1 : 0);

  for (const table of RECONCILE_TABLES.slice(firstIndex, lastIndex + 1)) {
    const corrected = correctedOf(response[table]);
    if (corrected === null) {
      throw new Error(`reconcile_hub_counts window omitted ${table}`);
    }
    const running = totals[table] ?? { corrected: 0, deferred: 0 };
    running.corrected += corrected;
    running.deferred += deferredOf(response[table]);
    totals[table] = running;
  }

  if (
    next !== null &&
    cursor !== null &&
    next.table === cursor.table &&
    next.afterId === cursor.afterId
  ) {
    throw new Error("reconcile_hub_counts cursor did not advance");
  }

  return next;
}

/** Walk windows until the pass completes, yields, fails, or exhausts a budget. */
async function walkWindows(deps: ReconcileHubCountsDeps, totals: Totals): Promise<Walk> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const walk: Walk = {
    cursor: null,
    error: null,
    legacy: false,
    reason: null,
    stop: "partial",
    tookMs: null,
    windows: 0,
  };

  try {
    while (walk.windows < MAX_WINDOWS) {
      if (walk.windows > 0 && now() - startedAt >= WINDOW_START_BUDGET_MS) {
        walk.reason = "wall_budget";
        return walk;
      }

      const response = await deps.reconcile(walk.cursor);
      if (response === undefined) {
        walk.stop = "yielded";
        return walk;
      }
      if (response.ok !== true) {
        throw new Error("reconcile_hub_counts did not ack");
      }

      walk.windows += 1;
      if (typeof response.tookMs === "number") {
        walk.tookMs = (walk.tookMs ?? 0) + response.tookMs;
      }

      if (!("next" in response)) {
        foldLegacyResponse(totals, response);
        walk.legacy = true;
        walk.stop = "complete";
        return walk;
      }

      const next = foldWindowResponse(totals, walk.cursor, response);
      if (next === null) {
        walk.stop = "complete";
        return walk;
      }
      walk.cursor = next;
    }
    walk.reason = "window_budget";
  } catch (error) {
    walk.stop = "failed";
    walk.error = error instanceof Error ? error.message : String(error);
  }

  return walk;
}

function sumOf(totals: Totals, field: "corrected" | "deferred"): number {
  return RECONCILE_TABLES.reduce((sum, table) => sum + (totals[table]?.[field] ?? 0), 0);
}

/**
 * THE AUDIT LINE. Emitted on EVERY tick that read a result — a run of zeroes is the evidence the
 * counters are healthy, and a non-zero reading is the evidence a write path is leaking. Both
 * belong in the journal, so this is never conditional on drift being found.
 */
function logAudit(
  write: (message: string) => void,
  summary: ReconcileHubCountsSummary,
  walk: Walk,
): void {
  if (walk.windows === 0) {
    return;
  }
  const stopped =
    walk.stop === "yielded"
      ? " partial=database_admission"
      : walk.stop === "partial"
        ? ` partial=${walk.reason ?? "unknown"}`
        : "";

  write(
    `AUDIT corrected=${summary.corrected ?? "?"} labels=${summary.labels ?? "?"} ` +
      `albums=${summary.albums ?? "?"} artists=${summary.artists ?? "?"} ` +
      `tookMs=${summary.tookMs ?? "?"}` +
      (summary.deferred === null ? "" : ` deferred=${summary.deferred}`) +
      stopped,
  );
}

/** A Worker without windows: the single response's tables, with the blindness detector. */
function legacySummary(
  deps: ReconcileHubCountsDeps,
  summary: ReconcileHubCountsSummary,
  totals: Totals,
  walk: Walk,
): ReconcileHubCountsSummary {
  const perTable = [summary.labels, summary.albums, summary.artists];
  summary.checked = perTable.filter((value) => value !== null).length;
  summary.corrected = perTable.every((value) => value !== null) ? sumOf(totals, "corrected") : null;
  summary.produced = summary.corrected;

  // This is a detector: an acknowledged response with no readable table result proved
  // nothing. A healthy all-zero pass is checked:3 / produced:0; checked:0 is blindness.
  if (summary.checked === 0) {
    summary.ok = false;
    summary.error = "reconcile_hub_counts inspected no tables";
    summary.errors = 1;
    deps.log(`reconcile failed: ${summary.error}`);

    return summary;
  }

  logAudit(deps.log, summary, walk);
  return summary;
}

// ── One tick, with injected effects ──────────────────────────────────────────

export async function runReconcileHubCountsTick(
  deps: ReconcileHubCountsDeps,
): Promise<ReconcileHubCountsSummary> {
  const totals: Totals = { albums: null, artists: null, labels: null };
  const walk = await walkWindows(deps, totals);
  const summary: ReconcileHubCountsSummary = {
    albums: totals.albums?.corrected ?? null,
    artists: totals.artists?.corrected ?? null,
    // Tables before the resume cursor's table are complete.
    checked: walk.cursor === null ? 0 : RECONCILE_TABLES.indexOf(walk.cursor.table),
    corrected: null,
    deferred: null,
    error: null,
    errors: 0,
    labels: totals.labels?.corrected ?? null,
    ok: true,
    partial: false,
    produced: null,
    reason: walk.reason,
    tookMs: walk.tookMs,
    windows: walk.windows,
  };

  if (walk.stop === "failed") {
    summary.ok = false;
    summary.error = walk.error;
    summary.errors = 1;
    deps.log(`reconcile failed: ${walk.error ?? "unknown error"}`);

    return summary;
  }
  if (walk.legacy) {
    return legacySummary(deps, summary, totals, walk);
  }

  const landed = sumOf(totals, "corrected");
  summary.deferred = sumOf(totals, "deferred");
  summary.produced = landed;
  if (walk.stop === "complete") {
    summary.checked = RECONCILE_TABLES.length;
    summary.corrected = landed;
  } else {
    summary.partial = true;
  }
  logAudit(deps.log, summary, walk);

  if (walk.stop === "yielded") {
    // Designed backpressure: the windows that landed stay counted, the yielded one is discarded.
    return {
      ...summary,
      ...databaseAdmissionYieldSummary({
        checked: summary.checked,
        partial: true,
        produced: landed,
      }),
    } as ReconcileHubCountsSummary;
  }

  return summary;
}

// ── The real (box-side) effects ─────────────────────────────────────────────────

/** One window request, issued exactly once. */
async function postReconcileWindow(
  cursor: ReconcileCursor | null,
): Promise<ReconcileHubCountsResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/hub-counts/reconcile`, {
    body: JSON.stringify(windowBody(cursor)),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(WINDOW_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(
      `reconcile_hub_counts failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  return (await res.json()) as ReconcileHubCountsResponse;
}

/** Parse a completed window child's stdout envelope. */
export function parseWindowEnvelope(stdout: string): ReconcileHubCountsResponse {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("reconcile window returned an invalid envelope");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("reconcile window returned an invalid envelope");
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope.kind === "failed") {
    // The child's own error travels as data, so the run's failure summary keeps its message.
    throw new Error(
      typeof envelope.error === "string" ? envelope.error : "reconcile window failed",
    );
  }
  if (
    envelope.kind === "window" &&
    typeof envelope.response === "object" &&
    envelope.response !== null &&
    !Array.isArray(envelope.response)
  ) {
    return envelope.response as ReconcileHubCountsResponse;
  }

  throw new Error("reconcile window returned an invalid envelope");
}

/** Every window is its own admission phase; nothing between windows holds the lease. */
function admittedWindow(
  cursor: ReconcileCursor | null,
): Promise<ReconcileHubCountsResponse | undefined> {
  const phase = runDatabaseAdmissionPhase({
    command: [process.execPath, import.meta.path, "--admission-phase", JSON.stringify(cursor)],
    owner: ADMISSION_OWNER,
    yieldRetries: WINDOW_YIELD_RETRIES,
  });

  return Promise.resolve(phase.kind === "yielded" ? undefined : parseWindowEnvelope(phase.stdout));
}

/** One window child. It never throws; it prints exactly one envelope. */
async function runWindowChild(
  cursorArgument: string | undefined,
): Promise<Record<string, unknown>> {
  try {
    const cursor = parseReconcileCursor(JSON.parse(cursorArgument ?? "null"));

    return { kind: "window", response: await postReconcileWindow(cursor) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(
      JSON.stringify({
        checked: 0,
        errors: 1,
        ok: false,
        produced: null,
        reason: "missing_api_token",
      }),
    );
    process.exit(1);
  }

  const summary = await runReconcileHubCountsTick({
    log,
    // An installed unit that still wraps this script already owns a whole-lifetime lease. Nesting
    // phase admission under it would wait on itself, so only that inherited runner context keeps
    // the in-process windows.
    reconcile: process.env.FLUNCLE_ADMISSION_RUNNER_PID ? postReconcileWindow : admittedWindow,
  });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const phaseIndex = argv.indexOf("--admission-phase");

  if (phaseIndex >= 0) {
    // A window child: its one stdout line is the envelope the parent parses.
    void runWindowChild(argv[phaseIndex + 1]).then((envelope) => {
      console.log(JSON.stringify(envelope));
    });
  } else {
    main().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`reconcile-hub-counts failed: ${message}`);
      console.log(
        JSON.stringify({
          checked: 0,
          error: message,
          errors: 1,
          ok: false,
          produced: null,
          reason: "reconcile_failed",
        }),
      );
      process.exit(1);
    });
  }
}
