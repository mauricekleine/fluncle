#!/usr/bin/env bun
// Keep the four runtime projection families converged after their cutovers open.
// The Worker owns every mutation; this box process only reads bounded status and invokes the
// fixed repair action with a fixed per-tick request budget. Rebuild, audit, and cutover remain
// attended operator operations.

import { spawnSync } from "node:child_process";

const REPAIR_LIMIT = 500;
const DUE_WORK_MAX_STEPS = 20;
const PUBLIC_MAX_STEPS = 4;

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

/** Run one status-gated tick. The four family failures are isolated deliberately. */
export function runProjectionMaintenanceTick(
  run: RunCommand = fluncleJson,
): ProjectionMaintenanceSummary {
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
  summary.trackDueWork = maintainFamily(
    run,
    "track_due_work",
    cutovers.trackDueWork,
    hasRepairDebt(status.status.projections.trackDueWork),
    DUE_WORK_MAX_STEPS,
    markerAge(status.status.projections.trackDueWork),
  );
  summary.crawlDueWork = maintainFamily(
    run,
    "crawl_due_work",
    cutovers.crawlDueWork,
    hasRepairDebt(status.status.projections.crawlDueWork),
    DUE_WORK_MAX_STEPS,
    markerAge(status.status.projections.crawlDueWork),
  );
  const aggregates = status.status.projections.publicAggregates;
  summary.publicAggregates = maintainFamily(
    run,
    "public_aggregates",
    cutovers.publicProjections,
    needsRepair(aggregates) || !aggregates.anchorsReady,
    PUBLIC_MAX_STEPS,
    markerAge(aggregates),
  );

  const artists = status.status.projections.artistQualification;
  summary.artistQualification = maintainFamily(
    run,
    "artist_qualification",
    cutovers.publicProjections,
    needsRepair(artists),
    PUBLIC_MAX_STEPS,
    markerAge(artists),
  );

  const targetedFamilies: readonly (readonly [FamilyName, FamilySummary])[] = [
    ["track_due_work", summary.trackDueWork],
    ["crawl_due_work", summary.crawlDueWork],
    ["public_aggregates", summary.publicAggregates],
    ["artist_qualification", summary.artistQualification],
  ];
  const families = targetedFamilies.map(([, family]) => family);
  summary.outcome = worstOutcome(families);
  summary.budgetExhaustedFamilies = targetedFamilies.flatMap(([target, family]) =>
    family.complete === false && family.error === null ? [target] : [],
  );
  summary.converged = families.every(
    (family) => family.outcome === null || family.outcome === "no_debt" || family.complete === true,
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
