#!/usr/bin/env bun
// Keep the four runtime projection families converged after their cutovers open.
// The Worker owns every mutation; this box process only reads bounded status and invokes the
// fixed repair action with a fixed per-tick request budget. Rebuild, audit, and cutover remain
// attended operator operations.

import { spawnSync } from "node:child_process";

const REPAIR_LIMIT = 500;

/**
 * The CLI's own bound on sequential advance calls in one invocation
 * (`apps/cli/src/commands/admin-projections.ts`). No family may ask for more than this.
 */
const PROJECTION_MAX_STEPS = 100;

/**
 * Steps a family takes when its debt is bounded and fresh: enough to clear what the status read
 * measured, plus one for what producers append while the tick runs.
 */
const STEPS_HEADROOM = 1;

/**
 * Markers one due-work step converges. A FLOOR under the server's `SOURCE_REPAIR_LIMIT`
 * (apps/web/src/lib/server/due-work-source-repair.ts): this script is baked into the box image and
 * lags the Worker, and it only sizes an adaptive step count, so understating the server's page asks
 * for steps the server finishes early while overstating it would under-drain measured debt.
 */
const DUE_WORK_MARKERS_PER_STEP = 5;

/** Subjects one public-family step repairs directly, at the requested limit. */
const PUBLIC_SUBJECTS_PER_STEP = REPAIR_LIMIT;

/**
 * Steps a public family takes whatever its marker count says.
 *
 * The two public families do not converge on markers alone: an unmatched epoch, and for public
 * aggregates an invalid anchor document, are repair work the bounded status read reports as zero
 * markers. Sizing them from the count alone would buy one step for work that is several pages long,
 * so their floor is the fixed budget they had before the step count became adaptive; escalation
 * still lifts them to the ceiling.
 */
const PUBLIC_MIN_STEPS = 4;

/**
 * Debt older than this is not a page behind — it is a set that never empties. A source-repair page
 * drains in primary-key order, so a marker only ages when every tick leaves markers behind it; the
 * family then spends its full step ceiling until the set empties again.
 */
const DEBT_AGE_ESCALATION_MS = 60 * 60_000;

/**
 * The tick's wall budget, spent across families oldest debt first. It is deliberately well inside
 * the unit's own start timeout, which still sizes the worst case of five serial CLI deadlines: the
 * budget shapes an ordinary tick, the unit timeout bounds a pathological one. A family reached with
 * no budget left keeps its debt for the next tick, which sorts it first.
 */
const RUN_WALL_BUDGET_MS = 120_000;

/**
 * The wall budget one family's advance call is HANDED, as `--wall-ms`. The CLI stops issuing steps
 * once it is spent and returns what it did, so this is a bound the child honours rather than a
 * step count this script derives from an assumed per-step cost.
 *
 * Sizing it is the whole point: the tick holds ONE whole-lifetime write lease, so the lease share
 * is what maintenance costs the fleet's other writers. Four families at this budget is well under
 * the five-minute cadence, and a typical tick — one busy family plus short public calls — holds the
 * lane for well under a minute.
 */
const FAMILY_CALL_BUDGET_MS = 30_000;

/**
 * The smallest wall budget worth handing a family. Below it the call would buy roughly one round
 * trip, so the family is deferred to the next tick, where the oldest-debt-first order puts it first,
 * instead of spending the tail of this one on a call that cannot finish a page.
 */
const MIN_FAMILY_CALL_BUDGET_MS = 5_000;

/**
 * The child-process deadline for one CLI invocation. It must clear
 * {@link FAMILY_CALL_BUDGET_MS} plus the step already in flight when that budget runs out plus
 * process startup, with margin: the budget is what the child honours, and this deadline is the
 * backstop for a child that cannot honour anything. A child killed here reports NOTHING, so the
 * margin between the two is what keeps an ordinary busy tick out of that blind state.
 */
const CLI_CALL_TIMEOUT_MS = 60_000;

/**
 * The step ceiling used against a CLI that does not accept `--wall-ms`.
 *
 * This script and the `fluncle` CLI are baked into the same image but their pins do NOT move
 * together: a change here rebakes within the hour, while the CLI pin only moves once the release is
 * cut and the pin-drift bump merges. There is therefore a real window where the new sweep runs
 * against the old CLI, and sending it an unknown flag would fail every family — a self-inflicted
 * outage on the drain this bound exists to protect. In that window the sweep falls back to the
 * step-count bound, with a ceiling low enough that even a slow round trip cannot reach
 * {@link CLI_CALL_TIMEOUT_MS}: 30 steps is roughly 36 seconds at the hosted round trip, against a
 * 60-second child deadline. It is the safe mode, not the good one — it is deliberately well short
 * of what the wall budget affords, because an old CLI cannot report how long it has spent.
 */
const LEGACY_SAFE_MAX_STEPS = 30;

/** Probe deadline. Printing one help page is local work; anything slower is a broken binary. */
const CLI_PROBE_TIMEOUT_MS = 15_000;

export type FamilyName =
  | "artist_qualification"
  | "crawl_due_work"
  | "public_aggregates"
  | "track_due_work";

type BoundedCount = { count: number; truncated: boolean };
type OldestOutstandingMarkerAge = {
  ageMs: number | null;
  reason:
    | "marker_timestamp_invalid"
    | "marker_timestamp_unavailable"
    | "status_field_unavailable"
    | null;
  truncated: boolean;
};
type FamilyStatus = {
  convergence: { epochMatched: boolean | null };
  oldestOutstandingMarkerAge?: OldestOutstandingMarkerAge;
  /** Optional like the marker age: an older Worker that omits it reads as nothing to re-project. */
  rebuild?: { complete: boolean };
  repairs: { direct: BoundedCount; fanout: BoundedCount; total: BoundedCount };
};
type ProjectionStatusResponse = {
  ok: true;
  status: {
    cutovers: {
      crawlDueWork: boolean;
      publicProjections: boolean;
      trackDueWork: boolean;
    };
    projections: {
      artistQualification: FamilyStatus;
      crawlDueWork: FamilyStatus;
      publicAggregates: FamilyStatus & { anchorsReady: boolean };
      trackDueWork: FamilyStatus & { catalogueRankMarkerAgeMs?: null | number };
    };
  };
};
type AdvanceResponse = {
  action: "repair";
  complete: boolean;
  ok: true;
  processed: number;
  /**
   * The two due-work families only. `--action rebuild` is operator-tier and no cron runs it, so a
   * family whose stored definition version is older than the running code's is re-projected on this
   * repair path instead, with the page budget ordinary repair left behind. These report that walk
   * so a stalled re-projection is visible in the ledger rather than hiding inside `processed`.
   */
  rebuildRowsWalked?: number;
  rebuildStaleFamilies?: number;
  scheduled: number;
  steps: number;
  target: FamilyName;
  /** Absent against a CLI that predates `--wall-ms`; the call then ended on steps or completion. */
  wallStopped?: boolean;
};

export type FamilySummary = {
  attempted: boolean;
  complete: boolean | null;
  error: string | null;
  /**
   * Wall time this family's advance call spent, which is the slice of the tick's lease it held.
   *
   * The unit wraps the whole payload in ONE whole-lifetime lease, so the runner's own `hold_ms`
   * already reports what maintenance costs the write lane end to end — but not how that splits, and
   * the adaptive step budget moved the worst case per family from 100 markers to 1,400. This is the
   * per-family half of that, so the ledger can answer what share of the write lane maintenance
   * takes and which family takes it. Null when the family was not advanced.
   */
  leaseHoldMs: number | null;
  oldestOutstandingMarkerAge: OldestOutstandingMarkerAge | null;
  outcome: ProjectionMaintenanceOutcome | null;
  processed: number | null;
  /** Source rows this family's stale-definition rebuild walk covered; null when not advanced. */
  rebuildRowsWalked: number | null;
  /** Families still on an older definition version after this tick; null when not advanced. */
  rebuildStaleFamilies: number | null;
  scheduled: number | null;
  steps: number | null;
  /**
   * Which bound this family's call was issued under: `wall-ms` when the CLI honours a wall budget,
   * `steps` when the sweep is running against a CLI that predates the flag and falls back to the
   * safe step ceiling. Null when the family was not advanced. The ledger needs this because the two
   * modes have different drain rates, so a sudden throughput drop should read as a pin window
   * rather than as a stalling queue.
   */
  wallBound: "steps" | "wall-ms" | null;
  /** Whether the family's own wall budget, rather than completion or the step ceiling, ended it. */
  wallStopped: boolean | null;
};

export type ProjectionMaintenanceOutcome =
  | "no_debt"
  | "no_progress"
  | "partial_progress"
  | "timeout"
  | "useful_completion";

export type ProjectionMaintenanceSummary = {
  artistQualification: FamilySummary;
  budgetExhaustedFamilies: FamilyName[];
  /**
   * Age of the synthetic catalogue-rank corpus marker, straight from the opening status.
   *
   * That marker is a resumable rank REBUILD checkpoint, not fan-out debt: it clears only when a
   * whole generation completes against an unchanged corpus, and any corpus mutation restarts it, so
   * it can be hours old while every ordinary marker drains normally. The server keeps it out of
   * `oldestOutstandingMarkerAge` for exactly that reason; reporting it here is what stops it ageing
   * silently, and what makes a rank rebuild that has genuinely stalled visible in the ledger.
   */
  catalogueRankMarkerAgeMs: number | null;
  checked: number | null;
  converged: boolean | null;
  crawlDueWork: FamilySummary;
  errors: number;
  gateState: "active" | "disabled" | null;
  ok: boolean;
  oldestDebtAgeMs: number | null;
  outcome: ProjectionMaintenanceOutcome | null;
  produced: number | null;
  publicAggregates: FamilySummary;
  reason: string | null;
  /**
   * Wall time this tick spent inside advance calls, summed across families: the measured write-lane
   * cost of one maintenance tick, beside the `hold_ms` the admission runner reports for the whole
   * payload. The difference between the two is the status read plus process overhead.
   */
  totalLeaseHoldMs: number;
  trackDueWork: FamilySummary;
  /** Families this tick reached with no wall budget left. Their debt sorts first on the next tick. */
  wallDeferredFamilies: FamilyName[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedCount(value: unknown): value is BoundedCount {
  return (
    isObject(value) &&
    isNonnegativeInteger(value["count"]) &&
    typeof value["truncated"] === "boolean"
  );
}

function isOldestOutstandingMarkerAge(value: unknown): value is OldestOutstandingMarkerAge {
  return (
    isObject(value) &&
    (value["ageMs"] === null || isNonnegativeInteger(value["ageMs"])) &&
    (value["reason"] === null ||
      value["reason"] === "marker_timestamp_invalid" ||
      value["reason"] === "marker_timestamp_unavailable" ||
      value["reason"] === "status_field_unavailable") &&
    typeof value["truncated"] === "boolean"
  );
}

/** An age a server may not carry at all: absent, explicitly unknown, or a measured duration. */
function isOptionalAge(value: unknown): value is null | number | undefined {
  return value === undefined || value === null || isNonnegativeInteger(value);
}

function isFamilyStatus(value: unknown): value is FamilyStatus {
  if (!isObject(value) || !isObject(value["convergence"]) || !isObject(value["repairs"])) {
    return false;
  }
  const epochMatched = value["convergence"]["epochMatched"];
  return (
    (typeof epochMatched === "boolean" || epochMatched === null) &&
    (value["oldestOutstandingMarkerAge"] === undefined ||
      isOldestOutstandingMarkerAge(value["oldestOutstandingMarkerAge"])) &&
    isBoundedCount(value["repairs"]["direct"]) &&
    isBoundedCount(value["repairs"]["fanout"]) &&
    isBoundedCount(value["repairs"]["total"])
  );
}

function parseStatus(value: unknown): ProjectionStatusResponse {
  if (!isObject(value) || value["ok"] !== true || !isObject(value["status"])) {
    throw new Error("projection status response is malformed");
  }
  const cutovers = value["status"]["cutovers"];
  const projections = value["status"]["projections"];
  if (
    !isObject(cutovers) ||
    typeof cutovers["crawlDueWork"] !== "boolean" ||
    typeof cutovers["publicProjections"] !== "boolean" ||
    typeof cutovers["trackDueWork"] !== "boolean" ||
    !isObject(projections) ||
    !isFamilyStatus(projections["artistQualification"]) ||
    !isFamilyStatus(projections["crawlDueWork"]) ||
    !isFamilyStatus(projections["publicAggregates"]) ||
    typeof projections["publicAggregates"]["anchorsReady"] !== "boolean" ||
    !isFamilyStatus(projections["trackDueWork"]) ||
    !isOptionalAge(projections["trackDueWork"]["catalogueRankMarkerAgeMs"])
  ) {
    throw new Error("projection status response is malformed");
  }
  return value as ProjectionStatusResponse;
}

function parseAdvance(value: unknown, target: FamilyName, maxSteps: number): AdvanceResponse {
  if (
    !isObject(value) ||
    value["ok"] !== true ||
    value["action"] !== "repair" ||
    value["target"] !== target ||
    typeof value["complete"] !== "boolean" ||
    !isNonnegativeInteger(value["processed"]) ||
    !isNonnegativeInteger(value["scheduled"]) ||
    !isNonnegativeInteger(value["steps"]) ||
    value["steps"] < 1 ||
    value["steps"] > maxSteps ||
    (value["wallStopped"] !== undefined && typeof value["wallStopped"] !== "boolean")
  ) {
    throw new Error(`${target} repair response is malformed`);
  }
  return value as AdvanceResponse;
}

export type RunCommand = (args: string[]) => unknown;

/**
 * A CLI child that ran past its deadline and was killed. It is its own error because it is its own
 * failure mode: the child reports NOTHING, so the tick cannot say what it processed, how far it
 * got, or whether the family is draining — it only knows the lease was held for the full deadline.
 * An ordinary thrown error at least carries the server's reason.
 */
export class CliTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`fluncle ${command} exceeded its ${timeoutMs}ms deadline and was killed`);
    this.name = "CliTimeoutError";
  }
}

/**
 * Execute one CLI command and require both exit zero and one valid JSON document. `timeoutMs` is
 * the child deadline; only a test that must reach it in bounded time passes anything but the
 * default.
 */
export function fluncleJson(args: string[], timeoutMs: number = CLI_CALL_TIMEOUT_MS): unknown {
  const fluncleBin = process.env.FLUNCLE_BIN ?? "fluncle";
  const result = spawnSync(fluncleBin, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  // A killed child surfaces as an `ETIMEDOUT` spawn error on some runtimes and as the kill signal
  // alone on others; either way it is a deadline, never a missing binary.
  const timedOut =
    (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") ||
    (result.signal !== null && result.signal !== undefined);
  if (timedOut) {
    throw new CliTimeoutError(args.join(" "), timeoutMs);
  }
  if (result.error) {
    throw new Error(`failed to spawn ${fluncleBin}: ${result.error.message}`);
  }
  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const detail = code === 0 ? stdout : (result.stderr ?? "");
    throw new Error(
      `fluncle ${args.join(" ")} exited ${code} without JSON: ${detail.slice(0, 200)}`,
    );
  }
  if (code !== 0) {
    const detail =
      isObject(parsed) && typeof parsed["message"] === "string"
        ? parsed["message"]
        : `exit ${code}`;
    throw new Error(`fluncle ${args.join(" ")} failed: ${detail}`);
  }
  return parsed;
}

/**
 * Whether the bundled CLI accepts `--wall-ms`, read from its own help page.
 *
 * The help page is the binary's own statement of what it accepts, printed locally with no token,
 * no network, and no mutation, which makes it the one probe that is free to run on a box whose CLI
 * version this script cannot otherwise know. It FAILS CLOSED: a missing binary, a nonzero exit, or
 * anything unreadable answers false and the caller takes the safe step-count bound, because sending
 * an unknown flag to an old CLI fails every family while an unnecessary fallback only drains
 * slower.
 */
export function cliAcceptsWallMs(): boolean {
  const fluncleBin = process.env.FLUNCLE_BIN ?? "fluncle";
  const result = spawnSync(fluncleBin, ["admin", "projections", "advance", "--help"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: CLI_PROBE_TIMEOUT_MS,
  });
  if (result.error || (result.status ?? 1) !== 0) {
    return false;
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.includes("--wall-ms");
}

function emptyFamily(): FamilySummary {
  return {
    attempted: false,
    complete: null,
    error: null,
    leaseHoldMs: null,
    oldestOutstandingMarkerAge: null,
    outcome: null,
    processed: 0,
    rebuildRowsWalked: null,
    rebuildStaleFamilies: null,
    scheduled: 0,
    steps: 0,
    wallBound: null,
    wallStopped: null,
  };
}

function markerAge(family: FamilyStatus): OldestOutstandingMarkerAge {
  return (
    family.oldestOutstandingMarkerAge ?? {
      ageMs: null,
      reason: "status_field_unavailable",
      truncated: false,
    }
  );
}

function needsRepair(family: FamilyStatus): boolean {
  return family.repairs.total.count > 0 || family.convergence.epochMatched !== true;
}

function hasRepairDebt(family: FamilyStatus): boolean {
  return family.repairs.total.count > 0;
}

/**
 * A due-work family is advanced for repair debt OR for an incomplete rebuild. The second arm is
 * what makes the definition version self-driving: a deploy that changes a queue's order leaves
 * every affected checkpoint reading incomplete, and this gate is what brings the repair call that
 * carries the re-projection walk.
 */
function dueWorkNeedsAdvance(family: FamilyStatus): boolean {
  return hasRepairDebt(family) || family.rebuild?.complete === false;
}

/**
 * Size one family's advance to the debt the status read actually measured.
 *
 * A bounded, fresh count buys the steps that count needs and one more for what producers append
 * while the tick runs. Two states instead spend the ceiling: a TRUNCATED count, which is a floor
 * rather than a measurement and says nothing about how much debt is really there, and debt older
 * than {@link DEBT_AGE_ESCALATION_MS}, which says the set is not emptying between ticks. `minSteps`
 * is the floor for work the marker count cannot measure at all — an unmatched epoch, an invalid
 * anchor document — which is why the public families carry one and the due-work families do not.
 */
export function adaptiveSteps(
  family: FamilyStatus,
  subjectsPerStep: number,
  ceiling: number,
  minSteps: number,
): number {
  const debt = family.repairs.total;
  const ageMs = family.oldestOutstandingMarkerAge?.ageMs ?? null;
  if (debt.truncated || (ageMs !== null && ageMs >= DEBT_AGE_ESCALATION_MS)) {
    return ceiling;
  }
  const measured = Math.ceil(debt.count / Math.max(subjectsPerStep, 1));
  return Math.min(Math.max(measured + STEPS_HEADROOM, minSteps, 1), ceiling);
}

/**
 * The wall budget a family's advance call is handed with `remainingMs` of the tick's budget left.
 *
 * Zero means the tick has too little left to be worth a call; the family keeps its debt, and the
 * oldest-debt-first order puts it in front on the next tick rather than letting it starve behind a
 * busy neighbour. This replaces deriving a step count from an ASSUMED per-step cost: a step is one
 * round trip whose cost the script cannot know, so the bound that matters is stated in time and
 * handed to the child that can actually measure it.
 */
export function familyWallBudgetMs(remainingMs: number): number {
  if (remainingMs < MIN_FAMILY_CALL_BUDGET_MS) {
    return 0;
  }
  return Math.min(remainingMs, FAMILY_CALL_BUDGET_MS);
}

/**
 * The order families are advanced in: oldest outstanding marker first, then a family whose age the
 * status could not measure, then the rest. Serial advances under one wall budget would otherwise
 * always spend it on whichever family the fixed order named first, and the family at the back would
 * age without bound however much capacity the tick had.
 */
export function oldestDebtFirst<Family extends { ageMs: number | null }>(
  families: readonly Family[],
): Family[] {
  return [...families].sort((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1));
}

/** A family the tick reached with no wall budget left: known debt, untouched, not converged. */
function wallDeferredFamily(oldestOutstandingMarkerAge: OldestOutstandingMarkerAge): FamilySummary {
  return { ...emptyFamily(), complete: false, oldestOutstandingMarkerAge };
}

/** `wallMs` null means the CLI cannot honour a budget, so the step ceiling is the only bound. */
function advanceFamily(
  run: RunCommand,
  target: FamilyName,
  maxSteps: number,
  wallMs: number | null,
  oldestOutstandingMarkerAge: OldestOutstandingMarkerAge,
  now: () => number,
): FamilySummary {
  const wallBound = wallMs === null ? "steps" : "wall-ms";
  // Measured around the call rather than derived from the step count: a step's cost is a round
  // trip, and the whole point of reporting it is that the assumed cost is an assumption.
  const startedAt = now();
  try {
    const response = parseAdvance(
      run([
        "admin",
        "projections",
        "advance",
        "--target",
        target,
        "--action",
        "repair",
        "--limit",
        String(REPAIR_LIMIT),
        "--max-steps",
        String(maxSteps),
        ...(wallMs === null ? [] : ["--wall-ms", String(wallMs)]),
        "--no-terminal-status",
      ]),
      target,
      maxSteps,
    );
    return {
      attempted: true,
      complete: response.complete,
      error: null,
      leaseHoldMs: now() - startedAt,
      oldestOutstandingMarkerAge,
      outcome: response.complete
        ? "useful_completion"
        : response.processed > 0
          ? "partial_progress"
          : "no_progress",
      processed: response.processed,
      rebuildRowsWalked: response.rebuildRowsWalked ?? null,
      rebuildStaleFamilies: response.rebuildStaleFamilies ?? null,
      scheduled: response.scheduled,
      steps: response.steps,
      wallBound,
      // An old CLI reports no `wallStopped` and honours no budget, so the field is null there
      // rather than a false that would read as "the budget was not reached".
      wallStopped: wallMs === null ? null : (response.wallStopped ?? false),
    };
  } catch (error) {
    return {
      attempted: true,
      complete: false,
      error: error instanceof Error ? error.message : String(error),
      leaseHoldMs: now() - startedAt,
      oldestOutstandingMarkerAge,
      // A killed child is its own outcome. It reported nothing at all, so calling it `no_progress`
      // would claim the tick measured zero progress when it measured nothing — and that is the one
      // state where the family held the write lease for a full deadline with nothing to show.
      outcome: error instanceof CliTimeoutError ? "timeout" : "no_progress",
      processed: null,
      rebuildRowsWalked: null,
      rebuildStaleFamilies: null,
      scheduled: null,
      steps: null,
      wallBound,
      wallStopped: null,
    };
  }
}

function maintainFamily(
  run: RunCommand,
  target: FamilyName,
  enabled: boolean,
  repairNeeded: boolean,
  maxSteps: number,
  wallMs: number | null,
  oldestOutstandingMarkerAge: OldestOutstandingMarkerAge,
  now: () => number,
): FamilySummary {
  if (!enabled) {
    return { ...emptyFamily(), oldestOutstandingMarkerAge };
  }
  if (!repairNeeded) {
    return {
      ...emptyFamily(),
      complete: true,
      oldestOutstandingMarkerAge,
      outcome: "no_debt",
    };
  }
  return advanceFamily(run, target, maxSteps, wallMs, oldestOutstandingMarkerAge, now);
}

function worstOutcome(families: readonly FamilySummary[]): ProjectionMaintenanceOutcome | null {
  // No progress is worst because the tick left debt untouched; partial progress remains healthy
  // but incomplete, useful completion drained known debt, and no debt needed no work.
  // A timeout is worse than no progress: no progress is a measured zero, a timeout is a family
  // that held the write lease for a full deadline and reported nothing at all.
  const severity: Record<ProjectionMaintenanceOutcome, number> = {
    no_debt: 0,
    no_progress: 3,
    partial_progress: 2,
    timeout: 4,
    useful_completion: 1,
  };
  return families.reduce<ProjectionMaintenanceOutcome | null>((worst, family) => {
    if (family.outcome === null) {
      return worst;
    }
    return worst === null || severity[family.outcome] > severity[worst] ? family.outcome : worst;
  }, null);
}

/**
 * Run one status-gated tick. The four family failures are isolated deliberately.
 *
 * Families are advanced oldest debt first, each sized to the debt the status read measured and to
 * the tick's remaining wall budget, so a busy family can neither starve a quiet one nor hold the
 * lease past the unit's budget.
 */
export function runProjectionMaintenanceTick(
  run: RunCommand = fluncleJson,
  options: { acceptsWallMs?: () => boolean; now?: () => number } = {},
): ProjectionMaintenanceSummary {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  // Probed at most ONCE per run, and only on a tick that will actually advance something: the
  // answer cannot change mid-run, and a dark or debt-free tick should spawn nothing at all.
  const probe = options.acceptsWallMs ?? cliAcceptsWallMs;
  let probed: boolean | undefined;
  const acceptsWallMs = (): boolean => {
    probed ??= probe();
    return probed;
  };
  const summary: ProjectionMaintenanceSummary = {
    artistQualification: emptyFamily(),
    budgetExhaustedFamilies: [],
    catalogueRankMarkerAgeMs: null,
    checked: null,
    converged: null,
    crawlDueWork: emptyFamily(),
    errors: 0,
    gateState: null,
    ok: true,
    oldestDebtAgeMs: null,
    outcome: null,
    produced: null,
    publicAggregates: emptyFamily(),
    reason: null,
    totalLeaseHoldMs: 0,
    trackDueWork: emptyFamily(),
    wallDeferredFamilies: [],
  };
  let status: ProjectionStatusResponse;
  try {
    status = parseStatus(run(["admin", "projections", "get"]));
  } catch (error) {
    summary.ok = false;
    summary.errors = 1;
    summary.outcome = "no_progress";
    summary.reason = error instanceof Error ? error.message : String(error);
    return summary;
  }

  const cutovers = status.status.cutovers;
  const activeFamilies =
    Number(cutovers.trackDueWork) +
    Number(cutovers.crawlDueWork) +
    (cutovers.publicProjections ? 2 : 0);
  if (activeFamilies === 0) {
    summary.checked = 0;
    summary.gateState = "disabled";
    summary.produced = 0;
    summary.reason = "projection_cutovers_disabled";
    return summary;
  }

  summary.checked = activeFamilies;
  summary.gateState = "active";

  const projections = status.status.projections;
  summary.catalogueRankMarkerAgeMs = projections.trackDueWork.catalogueRankMarkerAgeMs ?? null;
  const aggregates = projections.publicAggregates;
  const artists = projections.artistQualification;
  const plans = [
    {
      enabled: cutovers.trackDueWork,
      minSteps: 1,
      repairNeeded: dueWorkNeedsAdvance(projections.trackDueWork),
      status: projections.trackDueWork,
      subjectsPerStep: DUE_WORK_MARKERS_PER_STEP,
      target: "track_due_work",
    },
    {
      enabled: cutovers.crawlDueWork,
      minSteps: 1,
      repairNeeded: dueWorkNeedsAdvance(projections.crawlDueWork),
      status: projections.crawlDueWork,
      subjectsPerStep: DUE_WORK_MARKERS_PER_STEP,
      target: "crawl_due_work",
    },
    {
      enabled: cutovers.publicProjections,
      minSteps: PUBLIC_MIN_STEPS,
      repairNeeded: needsRepair(aggregates) || !aggregates.anchorsReady,
      status: aggregates,
      subjectsPerStep: PUBLIC_SUBJECTS_PER_STEP,
      target: "public_aggregates",
    },
    {
      enabled: cutovers.publicProjections,
      minSteps: PUBLIC_MIN_STEPS,
      repairNeeded: needsRepair(artists),
      status: artists,
      subjectsPerStep: PUBLIC_SUBJECTS_PER_STEP,
      target: "artist_qualification",
    },
  ] as const satisfies readonly {
    enabled: boolean;
    minSteps: number;
    repairNeeded: boolean;
    status: FamilyStatus;
    subjectsPerStep: number;
    target: FamilyName;
  }[];

  const results = new Map<FamilyName, FamilySummary>();
  for (const plan of oldestDebtFirst(
    plans.map((plan) => ({ ...plan, ageMs: markerAge(plan.status).ageMs })),
  )) {
    const age = markerAge(plan.status);
    if (!plan.enabled || !plan.repairNeeded) {
      results.set(
        plan.target,
        maintainFamily(run, plan.target, plan.enabled, false, 1, null, age, now),
      );
      continue;
    }
    const budget = familyWallBudgetMs(RUN_WALL_BUDGET_MS - (now() - startedAt));
    if (budget === 0) {
      summary.wallDeferredFamilies.push(plan.target);
      results.set(plan.target, wallDeferredFamily(age));
      continue;
    }
    // The step ceiling stays a HARD cap on requests issued; the wall budget is what actually ends
    // an ordinary busy call, so an escalated family asking for the ceiling can no longer run the
    // child past its deadline. Against a CLI that cannot honour a budget there is no such backstop,
    // so the ceiling itself has to be short enough to stay inside the child deadline.
    const wallMs = acceptsWallMs() ? budget : null;
    const steps = adaptiveSteps(
      plan.status,
      plan.subjectsPerStep,
      wallMs === null ? LEGACY_SAFE_MAX_STEPS : PROJECTION_MAX_STEPS,
      plan.minSteps,
    );
    results.set(plan.target, maintainFamily(run, plan.target, true, true, steps, wallMs, age, now));
  }

  const targetedFamilies: readonly (readonly [FamilyName, FamilySummary])[] = plans.map((plan) => [
    plan.target,
    results.get(plan.target) ?? emptyFamily(),
  ]);
  summary.trackDueWork = results.get("track_due_work") ?? emptyFamily();
  summary.crawlDueWork = results.get("crawl_due_work") ?? emptyFamily();
  summary.publicAggregates = results.get("public_aggregates") ?? emptyFamily();
  summary.artistQualification = results.get("artist_qualification") ?? emptyFamily();
  const families = targetedFamilies.map(([, family]) => family);
  summary.outcome = worstOutcome(families);
  summary.budgetExhaustedFamilies = targetedFamilies.flatMap(([target, family]) =>
    family.complete === false && family.error === null ? [target] : [],
  );
  // A family the tick never reached carries no outcome, so convergence is judged on `complete`:
  // a dark family is neutral (`null`), a drained one is `true`, and known debt this tick left
  // untouched is `false` and must not read as converged.
  summary.converged = families.every(
    (family) => family.complete === null || family.complete === true,
  );
  summary.oldestDebtAgeMs = families.reduce<number | null>((oldest, family) => {
    if (
      family.complete !== false ||
      family.oldestOutstandingMarkerAge?.ageMs === null ||
      family.oldestOutstandingMarkerAge?.ageMs === undefined
    ) {
      return oldest;
    }
    return Math.max(oldest ?? 0, family.oldestOutstandingMarkerAge.ageMs);
  }, null);
  // `ok` and `errors` report execution, not convergence. A clean bounded tick may exhaust
  // every family budget; `converged`, `outcome`, and `budgetExhaustedFamilies` carry that fact.
  summary.totalLeaseHoldMs = families.reduce(
    (total, family) => total + (family.leaseHoldMs ?? 0),
    0,
  );
  summary.errors = families.filter((family) => family.error !== null).length;
  summary.ok = summary.errors === 0;
  summary.produced = families.some((family) => family.processed === null)
    ? null
    : families.reduce((total, family) => total + (family.processed ?? 0), 0);
  return summary;
}

export function main(): ProjectionMaintenanceSummary {
  const summary = runProjectionMaintenanceTick();
  console.log(JSON.stringify(summary));
  return summary;
}

if (import.meta.main && !main().ok) {
  process.exit(1);
}
