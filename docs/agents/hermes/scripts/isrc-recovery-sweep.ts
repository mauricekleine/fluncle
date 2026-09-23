#!/usr/bin/env bun
// isrc-recovery-sweep.ts — the free Deezer-only ISRC-recovery pass.
//
// STANDING CONSTRAINT: this sweep NEVER calls `anchor_track` and NEVER runs Apify. It asks Deezer
// once per work row, then offers those candidates to the Worker's existing `resolve_anchor` gate
// with `spotifySearch: false`. The Worker alone verifies and writes an ISRC. A recovery moves the row
// into the ordinary anchor head, where the billed sweep can use the high-precision exact-ISRC rung.
//
// ── PHASED ADMISSION (docs/database-performance.md) ──────────────────────────────────────────
//
// A tick's shape is: ONE CLAIM WINDOW that reads the worklist, then every Deezer search — paced at
// {@link ISRC_RECOVERY_PACE_MS} per row, so a full batch is minutes of tokenless third-party
// waiting — with NO LEASE HELD AT ALL, then BOUNDED SETTLE WINDOWS that submit the `resolve_anchor`
// verdicts. The unadmitted leg runs between phase processes: no lease, no heartbeat, no
// admission-owned stop path. The unit therefore invokes this script directly rather than wrapping
// the whole payload in `database-admission-runner.sh`, exactly as `fluncle-crawl` and
// `fluncle-capture` do.
//
// A SETTLE WINDOW IS BOUNDED TWICE, by rows and by time ({@link SETTLE_WINDOW_ROWS},
// {@link SETTLE_WINDOW_BUDGET_MS}). The row bound is the natural unit; the time bound is what keeps
// the promise when the other side is slow, because `resolve_anchor` still runs the free
// ListenBrainz rung per row and a slow Worker must not be able to re-create a long hold. A window
// that spends its budget DEFERS the rows it never attempted, and they are settled by the next
// window — a fresh acquisition, never an extension of this one.
//
// A YIELDED WINDOW IS DESIGNED BACKPRESSURE, NEVER A LOSS. Nothing in this sweep is claimed or
// fenced: a row leaves the worklist only when `resolve_anchor` stamps its recovery ledger, so an
// unsettled row is simply eligible again on the next tick. The tick reports the pause and stops.
//
// stdout: exactly one JSON summary line. Diagnostics go to stderr.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";
import {
  dueWorkRepairPendingGate,
  failureBodyUnlessRepairPending,
  isDueWorkRepairPending,
  throwIfPageRepairPending,
} from "./due-work-repair-pending";

const DEFAULT_API_BASE_URL = "https://www.fluncle.com";
const DEFAULT_BATCH = 100;
const MAX_WORK_LIMIT = 200;
export const ADMISSION_OWNER = "fluncle-isrc-recovery";
export const ISRC_RECOVERY_EXPECTED_INTERVAL_MS = 60 * 60 * 1000;
export const ISRC_RECOVERY_PACE_MS = 1_100;

/**
 * Deezer's public search host. The default is the only value production ever uses; the override
 * exists so the out-of-process phase-boundary test can point the unadmitted leg at a local stub
 * and prove, from the runner's own timeline, that no lease is held while it runs.
 */
const DEEZER_API_BASE_URL = process.env.FLUNCLE_DEEZER_API_BASE_URL ?? "https://api.deezer.com";

/** Must follow the contract-owned `DEEZER_CANDIDATE_LIMIT`. The baked script cannot import workspace code. */
export const DEEZER_CANDIDATE_LIMIT = 5;
const DEEZER_QUOTA_ERROR_CODE = 4;
const DEEZER_TIMEOUT_MS = 10_000;
const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";
const DEEZER_QUOTA_RETRY_DELAYS_MS = [1_200, 2_500];

/** Three exhausted searches are enough evidence that the IP, rather than the rows, is blocked. */
export const DEEZER_QUOTA_ABORT_STREAK = 3;

/**
 * HOW MANY VERDICTS ONE ADMITTED SETTLE WINDOW SUBMITS.
 *
 * Ten is the row bound on a single lease. `resolve_anchor` is one small POST per row, but the
 * Worker answers it by running the free ListenBrainz rung, so the window's real cost is set by
 * somebody else's latency and the count alone cannot bound it — see
 * {@link SETTLE_WINDOW_BUDGET_MS}. Ten keeps a full 100-row batch inside ten acquisitions, which
 * matters on a lane this sweep has to queue for: a per-row window would trade one long hold for a
 * hundred waits.
 */
export const SETTLE_WINDOW_ROWS = 10;

/**
 * THE WINDOW'S OTHER BOUND, and the one that holds when the Worker is slow. The budget is read
 * BETWEEN items, so a window overshoots by at most one `resolve_anchor` — and twenty seconds sits
 * well inside both the 90-second lease and the 30-second heartbeat interval, so a window never has
 * to prove it is still alive to keep a lease it is about to release anyway.
 */
export const SETTLE_WINDOW_BUDGET_MS = 20_000;

/**
 * THE TICK'S WALL-CLOCK BACKSTOP. The unit kills this process at `TimeoutStartSec`, and a kill
 * writes no summary at all — the ledger then reads a silent sweep rather than a partial one. Each
 * settle window is a fresh acquisition that may wait out the runner's whole admission budget, so a
 * congested lane is exactly the condition under which a tick could run long. The budget is checked
 * before every acquisition, which bounds the overshoot to one wait plus one window. Rows the tick
 * never settles are untouched and eligible again immediately.
 */
export const ISRC_RECOVERY_WALL_BUDGET_MS = 840_000;

/**
 * THE BLIND-SWEEP TRIPWIRE. A Deezer-empty result is the one negative this pass writes down, and it
 * is indistinguishable from a broken ASK: a query spelling Deezer no longer honours answers
 * `{"data":[],"total":0}` for every row, and every one of those lands as a durable clean miss on
 * `isrc_recovery_attempted_at` while the tick reports `ok: true`.
 *
 * So the RATE is the alarm. A healthy pass finds something for a large minority of rows; a pass
 * where essentially every searched row came back empty is a statement about the query, the endpoint,
 * or the IP — never about the catalogue. Over {@link DEEZER_BLIND_MIN_SEARCHED} searched rows, an
 * empty share at or above {@link DEEZER_BLIND_EMPTY_SHARE} fails the tick (`ok: false` +
 * `reason: "deezer_blind"`), which is what the ledger reads and what the unit's OnFailure alert
 * fires on. The counts stay honest either way — the verdict is added, never substituted.
 *
 * The sample floor exists so a short or nearly-drained tick cannot trip it by luck; the share is
 * just under 1 so a single recovery in a hundred does not excuse a blind run.
 *
 * THE DENOMINATOR IS EVERY ROW DEEZER ANSWERED; the numerator is only the rows whose answer reached
 * a verdict. A tick that yields or runs out of wall budget therefore dilutes its own ratio and
 * cannot fire, which is the safe direction: an unsettled row is evidence about the lane, not about
 * the ask.
 */
export const DEEZER_BLIND_MIN_SEARCHED = 25;
export const DEEZER_BLIND_EMPTY_SHARE = 0.98;

export type IsrcRecoveryWorkItem = {
  deezerQuery?: string;
  trackId?: string;
};

export type DeezerCandidatePayload = {
  artistName: string;
  deezerTrackId?: string;
  durationMs: number;
  isrc: string;
  title: string;
};

export type ResolveAnchorVerdict = {
  anchored: boolean;
  isrcRecoveredByDeezer: boolean;
};

export type DeezerSearchOutcome =
  | { candidates: DeezerCandidatePayload[]; droppedIncomplete: number; outcome: "ok" }
  | { outcome: "quota" }
  | { outcome: "transport-failed" };

/** One row's candidates, waiting for the tick's next admitted settle window. */
export type IsrcRecoverySettleItem = {
  candidates: DeezerCandidatePayload[];
  /** Whether Deezer's answer was a clean empty result, so the parent can count the miss. */
  cleanEmpty: boolean;
  trackId: string;
};

export type IsrcRecoverySettleVerdict =
  | { message: string; outcome: "failed"; trackId: string }
  | ({ outcome: "settled"; trackId: string } & ResolveAnchorVerdict);

/** The claim window's envelope: the worklist page, or the Worker's typed deferral. */
export type IsrcRecoveryQueueWindow =
  | { kind: "queue"; queueDepth: number; rows: IsrcRecoveryWorkItem[] }
  | { kind: "repair-pending"; message: string };

/**
 * One settle window's envelope. `deferred` holds the rows the window's own time budget stopped
 * before — never attempted, never stamped, and handed straight back to the next window.
 */
export type IsrcRecoverySettleWindow = {
  deferred: string[];
  kind: "settle";
  verdicts: IsrcRecoverySettleVerdict[];
};

/**
 * The tick's two database windows. Production runs each one inside its own admitted child phase;
 * an inherited whole-lifetime lease and the tests run the same functions in-process. `undefined`
 * always means the phase yielded before its command ran.
 */
export type IsrcRecoveryWindows = {
  readQueue: (limit: number) => Promise<IsrcRecoveryQueueWindow | undefined>;
  settle: (
    items: readonly IsrcRecoverySettleItem[],
  ) => Promise<IsrcRecoverySettleWindow | undefined>;
};

export type IsrcRecoverySummary = {
  /** Present when a database-admission phase yielded; see `databaseAdmissionYieldSummary`. */
  admissionOutcome?: string;
  admissionYieldReason?: string;
  checked: number;
  deezerEmpty: number;
  /** Deezer hits withheld because they lacked one of the four fields the Worker gate requires. */
  deezerHitsDroppedIncomplete: number;
  errors: number;
  expectedIntervalMs: number;
  /** Per-row dependency or work-item failures; `errors` is reserved for a failed tick. */
  failed: number;
  gateRefused: number;
  ok: boolean;
  produced: number;
  /**
   * Rows still eligible after the tick. Every successful resolver call settles the dedicated
   * recovery ledger and leaves the current queue, including clean-empty and incomplete-hit results.
   * Quota and Deezer transport outcomes remain eligible. Resolver transport is not deducted because
   * the Worker may have committed before the response was lost; settlement stays unknown until the
   * next queue read. A row no settle window reached is likewise not deducted. Null means the queue
   * read itself failed.
   */
  queueDepth: number | null;
  /**
   * Rows blocked by quota, including each exhausted quota search plus every uninspected remainder
   * after the third consecutive quota outcome aborts the tick.
   */
  quotaBlocked: number;
  /**
   * Why the tick failed or paused, when the outcome is a VERDICT rather than a thrown error:
   * `deezer_blind` (the {@link DEEZER_BLIND_EMPTY_SHARE} tripwire, the one value that also fails
   * the tick), `database_admission` (a settle window yielded), `due_work_repair_pending` (the
   * Worker deferred the claim), or `wall_budget` ({@link ISRC_RECOVERY_WALL_BUDGET_MS} stopped the
   * settle). Null on a healthy tick and on an ordinary error, whose message already rides `errors`.
   */
  reason: string | null;
  recovered: number;
  /** Malformed work rows that could not be attempted. */
  skipped: number;
  transportFailed: number;
  /** Rows this tick searched but left unsettled — eligible again on the next tick. */
  unsettled: number;
  /**
   * The shared gate vocabulary, present only on a paused tick — the due-work deferral
   * (`dueWorkRepairPendingGate`) and the database-admission phase yield report it in exactly the
   * same fields, so one reading of a run row covers both.
   */
} & { gateState?: "paused"; partial?: boolean; throttled?: boolean };

export type IsrcRecoveryDeps = {
  log: (message: string) => void;
  /** Injectable so the wall-clock backstop is testable without waiting on it. */
  now?: () => number;
  searchDeezer: (query: string) => Promise<DeezerSearchOutcome>;
  sleep: (ms: number) => Promise<void>;
  windows: IsrcRecoveryWindows;
};

export type RuntimeEffects = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: (message: string) => void;
  output: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Injectable database windows. Absent selects the admitted child phases below. */
  windows?: IsrcRecoveryWindows;
};

function emptySummary(): IsrcRecoverySummary {
  return {
    checked: 0,
    deezerEmpty: 0,
    deezerHitsDroppedIncomplete: 0,
    errors: 0,
    expectedIntervalMs: ISRC_RECOVERY_EXPECTED_INTERVAL_MS,
    failed: 0,
    gateRefused: 0,
    ok: true,
    produced: 0,
    queueDepth: null,
    quotaBlocked: 0,
    reason: null,
    recovered: 0,
    skipped: 0,
    transportFailed: 0,
    unsettled: 0,
  };
}

function settleQueueRow(summary: IsrcRecoverySummary): void {
  if (summary.queueDepth !== null && summary.queueDepth > 0) {
    summary.queueDepth -= 1;
  }
}

/**
 * The paused-backpressure summary for a yielded settle window: the tick's measured counts, plus the
 * shared gate vocabulary every phased sweep reports. `partial` states that work was measured before
 * the pause.
 */
function admissionYieldSummary(summary: IsrcRecoverySummary): IsrcRecoverySummary {
  return {
    ...summary,
    ...databaseAdmissionYieldSummary({ produced: summary.produced }),
    gateState: "paused",
    partial: summary.checked > 0 || summary.produced > 0,
  };
}

// ---------------------------------------------------------------------------
// The unadmitted leg — every Deezer search, between phase processes.
// ---------------------------------------------------------------------------

type SearchedRows = {
  /** Rows Deezer ANSWERED (an `ok` response, empty or not) — the blind tripwire's denominator. */
  answered: number;
  items: IsrcRecoverySettleItem[];
};

/**
 * Search Deezer for every claimed row, paced and serial, holding NO database lease. The quota abort
 * streak still ends the leg early, and the rows it never reached are reported as quota-blocked
 * exactly as they were when this loop ran inside a lease.
 */
async function searchClaimedRows(
  rows: readonly IsrcRecoveryWorkItem[],
  summary: IsrcRecoverySummary,
  deps: IsrcRecoveryDeps,
): Promise<SearchedRows> {
  const items: IsrcRecoverySettleItem[] = [];
  let consecutiveQuota = 0;
  let answered = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    summary.checked += 1;

    const trackId = row?.trackId?.trim() ?? "";
    const deezerQuery = row?.deezerQuery?.trim() ?? "";

    if (!trackId || !deezerQuery) {
      summary.failed += 1;
      summary.skipped += 1;
      consecutiveQuota = 0;
      deps.log(`${trackId || "unknown-track"}: work row omitted trackId or deezerQuery`);
    } else {
      const search = await deps.searchDeezer(deezerQuery);

      if (search.outcome === "quota") {
        summary.quotaBlocked += 1;
        consecutiveQuota += 1;

        if (consecutiveQuota >= DEEZER_QUOTA_ABORT_STREAK) {
          // The remainder was not searched because the quota streak made its outcome predictable.
          summary.quotaBlocked += rows.length - index - 1;
          deps.log(`aborting after ${consecutiveQuota} consecutive Deezer quota outcomes`);
          break;
        }
      } else if (search.outcome === "transport-failed") {
        summary.failed += 1;
        summary.transportFailed += 1;
        consecutiveQuota = 0;
      } else {
        consecutiveQuota = 0;
        answered += 1;
        summary.deezerHitsDroppedIncomplete += search.droppedIncomplete;
        items.push({
          candidates: search.candidates.slice(0, DEEZER_CANDIDATE_LIMIT),
          // Only a truly empty result set is a Deezer miss. A non-empty response whose hits were
          // all incomplete is reported by `deezerHitsDroppedIncomplete`, never collapsed into it.
          cleanEmpty: search.candidates.length === 0 && search.droppedIncomplete === 0,
          trackId,
        });
      }
    }

    if (index < rows.length - 1) {
      await deps.sleep(ISRC_RECOVERY_PACE_MS);
    }
  }

  return { answered, items };
}

// ---------------------------------------------------------------------------
// The tick.
// ---------------------------------------------------------------------------

/** Apply one settle window's verdicts, preserving the per-outcome accounting exactly. */
function applySettleWindow(
  window: IsrcRecoverySettleWindow,
  items: readonly IsrcRecoverySettleItem[],
  summary: IsrcRecoverySummary,
  deps: IsrcRecoveryDeps,
): void {
  const byTrackId = new Map(items.map((item) => [item.trackId, item]));

  for (const verdict of window.verdicts) {
    if (verdict.outcome === "failed") {
      summary.failed += 1;
      summary.transportFailed += 1;
      deps.log(`${verdict.trackId}: ${verdict.message}`);
      continue;
    }

    const item = byTrackId.get(verdict.trackId);

    if (verdict.isrcRecoveredByDeezer) {
      summary.recovered += 1;
      summary.produced += 1;
    } else if ((item?.candidates.length ?? 0) > 0) {
      summary.gateRefused += 1;
    } else if (item?.cleanEmpty === true) {
      summary.deezerEmpty += 1;
    }

    // Every successful resolver call settles exactly one row through the dedicated recovery
    // ledger, whether Deezer recovered, the gate refused, the clean response was empty (or
    // incomplete), or the free ListenBrainz rung anchored it. Quota and Deezer transport never
    // reach the resolver. Resolver transport leaves settlement unknown — the Worker may have
    // committed before the response was lost — so queue depth waits for the next queue read.
    settleQueueRow(summary);
  }
}

/** Run one bounded tick: one claim window, the unadmitted searches, then bounded settle windows. */
export async function runIsrcRecoverySweep(
  limit: number,
  deps: IsrcRecoveryDeps,
): Promise<IsrcRecoverySummary> {
  const summary = emptySummary();
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const spentMs = (): number => now() - startedAt;
  let claimed: IsrcRecoveryQueueWindow | undefined;

  try {
    claimed = await deps.windows.readQueue(limit);
  } catch (error) {
    deps.log(error instanceof Error ? error.message : String(error));

    if (isDueWorkRepairPending(error)) {
      // The Worker deferred the read while due-work repair converges: nothing was read, so the tick
      // pauses cleanly and the next tick reads again.
      return { ...summary, ...dueWorkRepairPendingGate(summary) };
    }

    summary.errors = 1;
    summary.ok = false;
    return summary;
  }

  if (claimed === undefined) {
    // The claim window yielded before it ran, so no row was read and none can be lost.
    return admissionYieldSummary(summary);
  }

  if (claimed.kind === "repair-pending") {
    deps.log(claimed.message);
    return { ...summary, ...dueWorkRepairPendingGate(summary) };
  }

  summary.queueDepth = claimed.queueDepth;

  // NO LEASE IS HELD FROM HERE UNTIL THE FIRST SETTLE WINDOW.
  const searched = await searchClaimedRows(claimed.rows, summary, deps);
  let pending = [...searched.items];
  let yielded = false;

  while (pending.length > 0) {
    if (spentMs() >= ISRC_RECOVERY_WALL_BUDGET_MS) {
      summary.partial = true;
      summary.reason = "wall_budget";
      deps.log(`stopping with ${pending.length} row(s) unsettled: the tick's wall budget is spent`);
      break;
    }

    const chunk = pending.slice(0, SETTLE_WINDOW_ROWS);
    const window = await deps.windows.settle(chunk);

    if (window === undefined) {
      yielded = true;
      break;
    }

    applySettleWindow(window, chunk, summary, deps);

    if (window.deferred.length > 0) {
      deps.log(
        `a settle window spent its budget with ${window.deferred.length} row(s) unattempted`,
      );
    }

    // WHAT THE WINDOW ANSWERED ABOUT is the only thing that takes a row off the list — its deferral
    // list is diagnosis, not bookkeeping. A row the window deferred, and equally a row it simply did
    // not mention, goes back to the FRONT and takes the NEXT window's lease rather than this one's.
    const answered = new Set(window.verdicts.map((verdict) => verdict.trackId));
    pending = [
      ...chunk.filter((item) => !answered.has(item.trackId)),
      ...pending.slice(chunk.length),
    ];

    if (answered.size === 0) {
      // A window that answered about nothing at all would loop forever; the rows stay eligible.
      summary.partial = true;
      deps.log(
        `a settle window answered about no row; leaving ${pending.length} for the next tick`,
      );
      break;
    }
  }

  summary.unsettled = pending.length;

  if (yielded) {
    return admissionYieldSummary(summary);
  }

  // THE TRIPWIRE, read off the tick's own counts (see DEEZER_BLIND_EMPTY_SHARE). A blind pass is
  // still a pass that wrote durable clean misses, so the verdict is reported rather than the work
  // undone — the operator clears the stamps with `requeue_isrc_recovery` once the ask is fixed.
  if (
    searched.answered >= DEEZER_BLIND_MIN_SEARCHED &&
    summary.deezerEmpty / searched.answered >= DEEZER_BLIND_EMPTY_SHARE
  ) {
    summary.ok = false;
    summary.reason = "deezer_blind";
    deps.log(
      `Deezer answered empty for ${summary.deezerEmpty}/${searched.answered} searched rows — the ask, not the catalogue`,
    );
  }

  return summary;
}

type DeezerAttempt =
  | { candidates: DeezerCandidatePayload[]; droppedIncomplete: number; outcome: "ok" }
  | { outcome: "quota" }
  | { outcome: "transport-failed" };

/**
 * One Deezer request. This duplicates the Worker client's classification because the production
 * image bakes only this scripts directory, so importing `apps/web` would leave an unresolved module
 * on the box. In particular, Deezer quota is HTTP 200 + error code 4; every other error body is a
 * failed search, and only a valid empty `data` array is an honest miss.
 */
async function attemptDeezerSearch(query: string, request: typeof fetch): Promise<DeezerAttempt> {
  let response: Response;

  try {
    response = await request(
      `${DEEZER_API_BASE_URL}/search/track?q=${encodeURIComponent(query)}&limit=${DEEZER_CANDIDATE_LIMIT}`,
      {
        headers: { "User-Agent": DEEZER_USER_AGENT },
        signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      },
    );
  } catch {
    return { outcome: "transport-failed" };
  }

  if (!response.ok) {
    return { outcome: "transport-failed" };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return { outcome: "transport-failed" };
  }

  const parsed = body as {
    data?: {
      artist?: { name?: string };
      duration?: number;
      id?: number;
      isrc?: string;
      title?: string;
    }[];
    error?: { code?: unknown };
  };

  if (parsed.error) {
    if (parsed.error.code === DEEZER_QUOTA_ERROR_CODE) {
      return { outcome: "quota" };
    }
    return { outcome: "transport-failed" };
  }

  if (!Array.isArray(parsed.data)) {
    return { outcome: "transport-failed" };
  }

  const candidates: DeezerCandidatePayload[] = [];
  let droppedIncomplete = 0;

  for (const hit of parsed.data.slice(0, DEEZER_CANDIDATE_LIMIT)) {
    const artistName = hit.artist?.name?.trim() ?? "";
    const isrc = hit.isrc?.trim() ?? "";
    const title = hit.title?.trim() ?? "";

    if (!artistName || !isrc || !title || typeof hit.duration !== "number" || hit.duration <= 0) {
      droppedIncomplete += 1;
      continue;
    }

    candidates.push({
      artistName,
      ...(typeof hit.id === "number" ? { deezerTrackId: String(hit.id) } : {}),
      durationMs: Math.round(hit.duration * 1000),
      isrc,
      title,
    });
  }

  return { candidates, droppedIncomplete, outcome: "ok" };
}

/** Search with bounded retries only for Deezer's explicit quota outcome. */
export async function searchDeezerCandidates(
  query: string,
  effects: Pick<RuntimeEffects, "fetch" | "sleep">,
  retryDelaysMs: number[] = DEEZER_QUOTA_RETRY_DELAYS_MS,
): Promise<DeezerSearchOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await attemptDeezerSearch(query, effects.fetch);

    if (result.outcome !== "quota") {
      return result;
    }

    const delay = retryDelaysMs[attempt];
    if (delay === undefined) {
      return { outcome: "quota" };
    }
    await effects.sleep(delay);
  }
}

function parseLimit(args: string[], configured: string | undefined): number {
  const fromArgs = args.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
  const flagIndex = args.indexOf("--limit");
  const raw = fromArgs ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined) ?? configured;
  const parsed = Number(raw ?? DEFAULT_BATCH);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BATCH;
  }
  return Math.min(Math.trunc(parsed), MAX_WORK_LIMIT);
}

// ---------------------------------------------------------------------------
// The database windows themselves — the only code that talks to the Worker.
// ---------------------------------------------------------------------------

function apiBaseUrl(effects: RuntimeEffects): string {
  return effects.env.FLUNCLE_API_BASE_URL ?? DEFAULT_API_BASE_URL;
}

/** THE CLAIM WINDOW: one guarded worklist read. */
export async function readIsrcRecoveryQueueWindow(
  limit: number,
  effects: RuntimeEffects,
): Promise<IsrcRecoveryQueueWindow> {
  const token = effects.env.FLUNCLE_API_TOKEN ?? "";

  try {
    const response = await effects.fetch(
      `${apiBaseUrl(effects)}/api/v1/admin/tracks/work?kind=isrc-recovery&limit=${limit}&count=true&debtAware=true`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      const body = await failureBodyUnlessRepairPending(response, "isrc-recovery queue read");
      throw new Error(
        `isrc-recovery queue read failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }

    const body = (await response.json()) as { queued?: unknown; tracks?: unknown };
    // A `count=true` read answers the backlog size even while repair converges, reporting the
    // withheld page as `debtPending`. This sweep consumes the PAGE, so it pauses on it exactly
    // as it pauses on the typed refusal.
    throwIfPageRepairPending("isrc-recovery queue read", body);
    if (!Array.isArray(body.tracks)) {
      throw new Error("isrc-recovery queue read returned a non-array tracks body");
    }
    if (
      typeof body.queued !== "number" ||
      !Number.isInteger(body.queued) ||
      body.queued < body.tracks.length
    ) {
      throw new Error("isrc-recovery queue read returned an invalid whole-queue count");
    }

    return { kind: "queue", queueDepth: body.queued, rows: body.tracks as IsrcRecoveryWorkItem[] };
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      // The deferral crosses the phase boundary as data: a non-zero child exit reads as a failed
      // phase, while this envelope tells the parent the queue was deferred rather than empty.
      return { kind: "repair-pending", message: error.message };
    }
    throw error;
  }
}

/**
 * ONE SETTLE WINDOW: the `resolve_anchor` verdicts for a bounded run of rows.
 *
 * The window stops offering rows once {@link SETTLE_WINDOW_BUDGET_MS} is spent and DEFERS the rest.
 * A per-row failure is this row's verdict and never the window's: its neighbours still settle, and
 * the failed row is simply eligible again.
 */
export async function settleIsrcRecoveryWindow(
  items: readonly IsrcRecoverySettleItem[],
  effects: RuntimeEffects,
  now: () => number = Date.now,
): Promise<IsrcRecoverySettleWindow> {
  const baseUrl = apiBaseUrl(effects);
  const token = effects.env.FLUNCLE_API_TOKEN ?? "";
  const startedAt = now();
  const verdicts: IsrcRecoverySettleVerdict[] = [];
  const deferred: string[] = [];

  for (const [index, item] of items.entries()) {
    if (index > 0 && now() - startedAt >= SETTLE_WINDOW_BUDGET_MS) {
      deferred.push(item.trackId);
      continue;
    }

    try {
      const response = await effects.fetch(`${baseUrl}/api/v1/admin/catalogue/anchor/resolve`, {
        body: JSON.stringify({
          deezerCandidates: item.candidates,
          spotifySearch: false,
          trackId: item.trackId,
        }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(
          `resolve_anchor ${item.trackId} failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
        );
      }

      const body = (await response.json()) as {
        anchored?: unknown;
        isrcRecoveredByDeezer?: unknown;
      };

      verdicts.push({
        anchored: body.anchored === true,
        isrcRecoveredByDeezer: body.isrcRecoveredByDeezer === true,
        outcome: "settled",
        trackId: item.trackId,
      });
    } catch (error) {
      verdicts.push({
        message: error instanceof Error ? error.message : String(error),
        outcome: "failed",
        trackId: item.trackId,
      });
    }
  }

  return { deferred, kind: "settle", verdicts };
}

/** An inherited whole-lifetime lease already covers this process, so windows run in-process. */
export function inProcessWindows(effects: RuntimeEffects): IsrcRecoveryWindows {
  return {
    readQueue: (limit) => readIsrcRecoveryQueueWindow(limit, effects),
    settle: (items) => settleIsrcRecoveryWindow(items, effects),
  };
}

// ---------------------------------------------------------------------------
// Admitted child phases.
// ---------------------------------------------------------------------------

export type IsrcRecoveryPhase = "claim" | "settle";

export function isIsrcRecoveryPhase(value: string | undefined): value is IsrcRecoveryPhase {
  return value === "claim" || value === "settle";
}

function phaseCommand(phase: IsrcRecoveryPhase, statePath: string): string[] {
  return [
    process.execPath,
    import.meta.path,
    "--admission-phase",
    phase,
    "--phase-state",
    statePath,
  ];
}

function windowEnvelope(stdout: string, phase: IsrcRecoveryPhase): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`isrc-recovery ${phase} window returned an invalid envelope`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`isrc-recovery ${phase} window returned an invalid envelope`);
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope.kind === "failed") {
    // The child's own error travels as data, so the run's fatal summary keeps its message.
    const message = envelope.error;

    throw new Error(typeof message === "string" ? message : `isrc-recovery ${phase} window failed`);
  }

  return envelope;
}

/** Parse a completed claim window's stdout envelope. */
export function parseQueueWindowEnvelope(stdout: string): IsrcRecoveryQueueWindow {
  const envelope = windowEnvelope(stdout, "claim");

  if (envelope.kind === "repair-pending") {
    const message = envelope.message;

    return {
      kind: "repair-pending",
      message: typeof message === "string" ? message : "isrc-recovery queue read deferred",
    };
  }

  if (
    envelope.kind === "queue" &&
    typeof envelope.queueDepth === "number" &&
    Number.isInteger(envelope.queueDepth) &&
    Array.isArray(envelope.rows)
  ) {
    return {
      kind: "queue",
      queueDepth: envelope.queueDepth,
      rows: envelope.rows as IsrcRecoveryWorkItem[],
    };
  }

  throw new Error("isrc-recovery claim window returned an invalid envelope");
}

/** Parse a completed settle window's stdout envelope. */
export function parseSettleWindowEnvelope(stdout: string): IsrcRecoverySettleWindow {
  const envelope = windowEnvelope(stdout, "settle");

  if (envelope.kind !== "settle" || !Array.isArray(envelope.verdicts)) {
    throw new Error("isrc-recovery settle window returned an invalid envelope");
  }

  const deferred = Array.isArray(envelope.deferred)
    ? envelope.deferred.filter((value): value is string => typeof value === "string")
    : [];

  return {
    deferred,
    kind: "settle",
    verdicts: envelope.verdicts.map((row) => {
      const record = row as { outcome?: unknown; trackId?: unknown };

      if (typeof record.trackId !== "string") {
        throw new Error("isrc-recovery settle window returned an invalid envelope");
      }

      if (record.outcome === "failed") {
        const message = (row as { message?: unknown }).message;

        return {
          message: typeof message === "string" ? message : "resolve_anchor failed",
          outcome: "failed" as const,
          trackId: record.trackId,
        };
      }

      if (record.outcome !== "settled") {
        throw new Error("isrc-recovery settle window returned an invalid envelope");
      }

      const verdict = row as { anchored?: unknown; isrcRecoveredByDeezer?: unknown };

      return {
        anchored: verdict.anchored === true,
        isrcRecoveredByDeezer: verdict.isrcRecoveredByDeezer === true,
        outcome: "settled" as const,
        trackId: record.trackId,
      };
    }),
  };
}

/**
 * Every database window is its own admission phase; the Deezer leg between them holds no lease.
 * `catalogue.isrc-recovery` is replay-safe, but a yielded window is never replayed in-run: its rows
 * are already eligible for the next tick, so an in-run retry would only queue again for the very
 * lane the window just lost.
 */
export function admittedWindows(): IsrcRecoveryWindows {
  const runPhase = (phase: IsrcRecoveryPhase, state: unknown): string | undefined => {
    const directory = mkdtempSync(join(tmpdir(), "fluncle-isrc-recovery-phase-"));
    const statePath = join(directory, `${phase}.json`);

    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });

    try {
      const result = runDatabaseAdmissionPhase({
        command: phaseCommand(phase, statePath),
        owner: ADMISSION_OWNER,
        yieldRetries: 0,
      });

      return result.kind === "yielded" ? undefined : result.stdout;
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  };

  return {
    readQueue: (limit) => {
      const stdout = runPhase("claim", { limit });

      return Promise.resolve(stdout === undefined ? undefined : parseQueueWindowEnvelope(stdout));
    },
    settle: (items) => {
      const stdout = runPhase("settle", { items });

      return Promise.resolve(stdout === undefined ? undefined : parseSettleWindowEnvelope(stdout));
    },
  };
}

/** One database window child. It never throws; it prints exactly one envelope. */
async function runWindowChild(
  phase: IsrcRecoveryPhase,
  statePath: string | undefined,
  effects: RuntimeEffects,
): Promise<Record<string, unknown>> {
  try {
    if (statePath === undefined) {
      return { error: "invalid isrc-recovery admission phase invocation", kind: "failed" };
    }

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      items?: IsrcRecoverySettleItem[];
      limit?: number;
    };

    if (phase === "claim") {
      return await readIsrcRecoveryQueueWindow(Number(state.limit ?? DEFAULT_BATCH), effects);
    }

    return await settleIsrcRecoveryWindow(state.items ?? [], effects);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

/** CLI entry with all side effects injectable: tests inspect the complete HTTP and stdout contract. */
export async function runIsrcRecoveryCli(
  args: string[],
  effects: RuntimeEffects,
): Promise<{ exitCode: number; summary: IsrcRecoverySummary }> {
  let summary: IsrcRecoverySummary;

  if (!(effects.env.FLUNCLE_API_TOKEN ?? "").trim()) {
    summary = { ...emptySummary(), errors: 1, ok: false };
  } else {
    const limit = parseLimit(args, effects.env.FLUNCLE_ISRC_RECOVERY_BATCH);
    // An installed unit that still wraps this script owns a whole-lifetime lease already. Nesting
    // phase admission under it would wait on itself, so only that inherited runner context keeps
    // the in-process windows.
    const windows =
      effects.windows ??
      (effects.env.FLUNCLE_ADMISSION_RUNNER_PID ? inProcessWindows(effects) : admittedWindows());

    summary = await runIsrcRecoverySweep(limit, {
      log: effects.log,
      searchDeezer: (query) => searchDeezerCandidates(query, effects),
      sleep: effects.sleep,
      windows,
    });
  }

  effects.output(JSON.stringify(summary));
  return { exitCode: summary.ok ? 0 : 1, summary };
}

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);

  return index >= 0 ? argv[index + 1] : undefined;
}

if (import.meta.main) {
  const effects: RuntimeEffects = {
    env: process.env,
    fetch: globalThis.fetch,
    log: (message) => console.error(`[isrc-recovery-sweep] ${message}`),
    output: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const argv = process.argv.slice(2);
  const admissionPhase = argumentValue(argv, "--admission-phase");

  if (admissionPhase === undefined) {
    runIsrcRecoveryCli(argv, effects)
      .then(({ exitCode }) => {
        process.exitCode = exitCode;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        effects.log(message);
        effects.output(JSON.stringify({ ...emptySummary(), errors: 1, ok: false }));
        process.exitCode = 1;
      });
  } else if (isIsrcRecoveryPhase(admissionPhase)) {
    // A database window child: its one stdout line is the envelope the parent parses.
    runWindowChild(admissionPhase, argumentValue(argv, "--phase-state"), effects)
      .then((envelope) => {
        console.log(JSON.stringify(envelope));
      })
      .catch((error: unknown) => {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            kind: "failed",
          }),
        );
      });
  } else {
    console.log(
      JSON.stringify({ error: "invalid isrc-recovery admission phase invocation", kind: "failed" }),
    );
    process.exitCode = 1;
  }
}
