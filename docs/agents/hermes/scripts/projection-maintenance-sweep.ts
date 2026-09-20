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
const RUN_WALL_BUDGET_MS = 240_000;

/**
 * Wall time one advance step is assumed to cost when sizing a family's call. It is an estimate for
 * budgeting only — the CLI's own per-process deadline is the hard bound — so it is set above the
 * round trip a step actually pays, and a family whose steps run faster simply finishes early.
 */
const STEP_ESTIMATE_MS = 1_000;

/**
 * Wall time one family's advance call may be sized for, inside the CLI child deadline this script
 * enforces in {@link fluncleJson}. It leaves that process room to exit and report.
 */
const FAMILY_CALL_BUDGET_MS = 100_000;

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
      trackDueWork: FamilyStatus;
    };
  };
};
type AdvanceResponse = {
  action: "repair";
  complete: boolean;
  ok: true;
  processed: number;
  scheduled: number;
  steps: number;
  target: FamilyName;
};

export type FamilySummary = {
  attempted: boolean;
  complete: boolean | null;
  error: string | null;
  oldestOutstandingMarkerAge: OldestOutstandingMarkerAge | null;
  outcome: ProjectionMaintenanceOutcome | null;
  processed: number | null;
  scheduled: number | null;
  steps: number | null;
};

export type ProjectionMaintenanceOutcome =
  | "no_debt"
  | "no_progress"
  | "partial_progress"
  | "useful_completion";

export type ProjectionMaintenanceSummary = {
  artistQualification: FamilySummary;
  budgetExhaustedFamilies: FamilyName[];
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
    !isFamilyStatus(projections["trackDueWork"])
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
    value["steps"] > maxSteps
  ) {
    throw new Error(`${target} repair response is malformed`);
  }
  return value as AdvanceResponse;
}

export type RunCommand = (args: string[]) => unknown;

/** Execute one CLI command and require both exit zero and one valid JSON document. */
export function fluncleJson(args: string[]): unknown {
  const fluncleBin = process.env.FLUNCLE_BIN ?? "fluncle";
  const result = spawnSync(fluncleBin, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
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

function emptyFamily(): FamilySummary {
  return {
    attempted: false,
    complete: null,
    error: null,
    oldestOutstandingMarkerAge: null,
    outcome: null,
    processed: 0,
    scheduled: 0,
    steps: 0,
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
 * Size one family's advance to the debt the status read actually measured.
 *
 * A bounded, fresh count buys the steps that count needs and one more for what producers append
 * while the tick runs. Two states instead spend the ceiling: a TRUNCATED count, which is a floor
 * rather than a measurement and says nothing about how much debt is really there, and debt older
 * than {@link DEBT_AGE_ESCALATION_MS}, which says the set is not emptying between ticks. A family
 * with no measured markers but an unmatched epoch still takes its headroom steps, because the epoch
 * is the other half of its convergence.
 */
export function adaptiveSteps(
  family: FamilyStatus,
  subjectsPerStep: number,
  ceiling: number,
): number {
  const debt = family.repairs.total;
  const ageMs = family.oldestOutstandingMarkerAge?.ageMs ?? null;
  if (debt.truncated || (ageMs !== null && ageMs >= DEBT_AGE_ESCALATION_MS)) {
    return ceiling;
  }
  const measured = Math.ceil(debt.count / Math.max(subjectsPerStep, 1));
  return Math.min(Math.max(measured + STEPS_HEADROOM, 1), ceiling);
}

/**
 * The steps a family may take with `remainingMs` of the tick's wall budget left. Zero means the
 * tick ran out of budget before reaching this family; it keeps its debt, and the oldest-debt-first
 * order puts it in front on the next tick rather than letting it starve behind a busy neighbour.
 */
export function wallBoundedSteps(requested: number, remainingMs: number): number {
  if (remainingMs <= 0) {
    return 0;
  }
  const affordable = Math.floor(Math.min(remainingMs, FAMILY_CALL_BUDGET_MS) / STEP_ESTIMATE_MS);
  return Math.max(0, Math.min(requested, affordable));
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

function advanceFamily(
  run: RunCommand,
  target: FamilyName,
  maxSteps: number,
  oldestOutstandingMarkerAge: OldestOutstandingMarkerAge,
): FamilySummary {
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
        "--no-terminal-status",
      ]),
      target,
      maxSteps,
    );
    return {
      attempted: true,
      complete: response.complete,
      error: null,
      oldestOutstandingMarkerAge,
      outcome: response.complete
        ? "useful_completion"
        : response.processed > 0
          ? "partial_progress"
          : "no_progress",
      processed: response.processed,
      scheduled: response.scheduled,
      steps: response.steps,
    };
  } catch (error) {
    return {
      attempted: true,
      complete: false,
      error: error instanceof Error ? error.message : String(error),
      oldestOutstandingMarkerAge,
      outcome: "no_progress",
      processed: null,
      scheduled: null,
      steps: null,
    };
  }
}

function maintainFamily(
  run: RunCommand,
  target: FamilyName,
  enabled: boolean,
  repairNeeded: boolean,
  maxSteps: number,
  oldestOutstandingMarkerAge: OldestOutstandingMarkerAge,
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
  return advanceFamily(run, target, maxSteps, oldestOutstandingMarkerAge);
}

function worstOutcome(families: readonly FamilySummary[]): ProjectionMaintenanceOutcome | null {
  // No progress is worst because the tick left debt untouched; partial progress remains healthy
  // but incomplete, useful completion drained known debt, and no debt needed no work.
  const severity: Record<ProjectionMaintenanceOutcome, number> = {
    no_debt: 0,
    no_progress: 3,
    partial_progress: 2,
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
  options: { now?: () => number } = {},
): ProjectionMaintenanceSummary {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const summary: ProjectionMaintenanceSummary = {
    artistQualification: emptyFamily(),
    budgetExhaustedFamilies: [],
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
  const aggregates = projections.publicAggregates;
  const artists = projections.artistQualification;
  const plans = [
    {
      enabled: cutovers.trackDueWork,
      repairNeeded: hasRepairDebt(projections.trackDueWork),
      status: projections.trackDueWork,
      subjectsPerStep: DUE_WORK_MARKERS_PER_STEP,
      target: "track_due_work",
    },
    {
      enabled: cutovers.crawlDueWork,
      repairNeeded: hasRepairDebt(projections.crawlDueWork),
      status: projections.crawlDueWork,
      subjectsPerStep: DUE_WORK_MARKERS_PER_STEP,
      target: "crawl_due_work",
    },
    {
      enabled: cutovers.publicProjections,
      repairNeeded: needsRepair(aggregates) || !aggregates.anchorsReady,
      status: aggregates,
      subjectsPerStep: PUBLIC_SUBJECTS_PER_STEP,
      target: "public_aggregates",
    },
    {
      enabled: cutovers.publicProjections,
      repairNeeded: needsRepair(artists),
      status: artists,
      subjectsPerStep: PUBLIC_SUBJECTS_PER_STEP,
      target: "artist_qualification",
    },
  ] as const satisfies readonly {
    enabled: boolean;
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
      results.set(plan.target, maintainFamily(run, plan.target, plan.enabled, false, 1, age));
      continue;
    }
    const requested = adaptiveSteps(plan.status, plan.subjectsPerStep, PROJECTION_MAX_STEPS);
    const steps = wallBoundedSteps(requested, RUN_WALL_BUDGET_MS - (now() - startedAt));
    if (steps === 0) {
      summary.wallDeferredFamilies.push(plan.target);
      results.set(plan.target, wallDeferredFamily(age));
      continue;
    }
    results.set(plan.target, maintainFamily(run, plan.target, true, true, steps, age));
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
