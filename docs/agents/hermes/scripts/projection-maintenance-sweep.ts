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
type FamilyStatus = {
  convergence: { epochMatched: boolean | null };
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
  processed: number | null;
  scheduled: number | null;
  steps: number | null;
};

export type ProjectionMaintenanceSummary = {
  artistQualification: FamilySummary;
  checked: number | null;
  crawlDueWork: FamilySummary;
  errors: number;
  gateState: "active" | "disabled" | null;
  ok: boolean;
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

function isFamilyStatus(value: unknown): value is FamilyStatus {
  if (!isObject(value) || !isObject(value["convergence"]) || !isObject(value["repairs"])) {
    return false;
  }
  const epochMatched = value["convergence"]["epochMatched"];
  return (
    (typeof epochMatched === "boolean" || epochMatched === null) &&
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
  return { attempted: false, complete: null, error: null, processed: 0, scheduled: 0, steps: 0 };
}

function needsRepair(family: FamilyStatus): boolean {
  return family.repairs.total.count > 0 || family.convergence.epochMatched !== true;
}

function hasRepairDebt(family: FamilyStatus): boolean {
  return family.repairs.total.count > 0;
}

function advanceFamily(run: RunCommand, target: FamilyName, maxSteps: number): FamilySummary {
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
      processed: response.processed,
      scheduled: response.scheduled,
      steps: response.steps,
    };
  } catch (error) {
    return {
      attempted: true,
      complete: false,
      error: error instanceof Error ? error.message : String(error),
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
): FamilySummary {
  if (!enabled) {
    return emptyFamily();
  }
  if (!repairNeeded) {
    return { ...emptyFamily(), complete: true };
  }
  return advanceFamily(run, target, maxSteps);
}

/** Run one status-gated tick. The four family failures are isolated deliberately. */
export function runProjectionMaintenanceTick(
  run: RunCommand = fluncleJson,
): ProjectionMaintenanceSummary {
  const summary: ProjectionMaintenanceSummary = {
    artistQualification: emptyFamily(),
    checked: null,
    crawlDueWork: emptyFamily(),
    errors: 0,
    gateState: null,
    ok: true,
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
  );
  summary.crawlDueWork = maintainFamily(
    run,
    "crawl_due_work",
    cutovers.crawlDueWork,
    hasRepairDebt(status.status.projections.crawlDueWork),
    DUE_WORK_MAX_STEPS,
  );
  const aggregates = status.status.projections.publicAggregates;
  summary.publicAggregates = maintainFamily(
    run,
    "public_aggregates",
    cutovers.publicProjections,
    needsRepair(aggregates) || !aggregates.anchorsReady,
    PUBLIC_MAX_STEPS,
  );

  const artists = status.status.projections.artistQualification;
  summary.artistQualification = maintainFamily(
    run,
    "artist_qualification",
    cutovers.publicProjections,
    needsRepair(artists),
    PUBLIC_MAX_STEPS,
  );

  const families = [
    summary.trackDueWork,
    summary.crawlDueWork,
    summary.publicAggregates,
    summary.artistQualification,
  ];
  summary.errors = families.filter((family) => family.error !== null).length;
  summary.ok = summary.errors === 0;
  summary.produced =
    summary.errors === 0
      ? families.reduce((total, family) => total + (family.processed ?? 0), 0)
      : null;
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
