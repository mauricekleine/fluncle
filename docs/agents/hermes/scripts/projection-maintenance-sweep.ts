#!/usr/bin/env bun
// Keep the two public projection families converged after their shared cutover opens.
// The Worker owns every mutation; this box process only reads bounded status and invokes the
// fixed repair action with a fixed per-tick request budget. Rebuild, audit, and cutover remain
// attended operator operations.

import { spawnSync } from "node:child_process";

const REPAIR_LIMIT = 500;
const MAX_STEPS = 4;

export type FamilyName = "artist_qualification" | "public_aggregates";

type BoundedCount = { count: number; truncated: boolean };
type FamilyStatus = {
  convergence: { epochMatched: boolean | null };
  repairs: { direct: BoundedCount; fanout: BoundedCount; total: BoundedCount };
};
type ProjectionStatusResponse = {
  ok: true;
  status: {
    cutovers: { publicProjections: boolean };
    projections: {
      artistQualification: FamilyStatus;
      publicAggregates: FamilyStatus & { anchorsReady: boolean };
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
  errors: number;
  gateState: "active" | "disabled" | null;
  ok: boolean;
  produced: number | null;
  publicAggregates: FamilySummary;
  reason: string | null;
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
    typeof cutovers["publicProjections"] !== "boolean" ||
    !isObject(projections) ||
    !isFamilyStatus(projections["artistQualification"]) ||
    !isFamilyStatus(projections["publicAggregates"]) ||
    typeof projections["publicAggregates"]["anchorsReady"] !== "boolean"
  ) {
    throw new Error("projection status response is malformed");
  }
  return value as ProjectionStatusResponse;
}

function parseAdvance(value: unknown, target: FamilyName): AdvanceResponse {
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
    value["steps"] > MAX_STEPS
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

function advanceFamily(run: RunCommand, target: FamilyName): FamilySummary {
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
        String(MAX_STEPS),
      ]),
      target,
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

/** Run one status-gated tick. The two family failures are isolated deliberately. */
export function runProjectionMaintenanceTick(
  run: RunCommand = fluncleJson,
): ProjectionMaintenanceSummary {
  const summary: ProjectionMaintenanceSummary = {
    artistQualification: emptyFamily(),
    checked: null,
    errors: 0,
    gateState: null,
    ok: true,
    produced: null,
    publicAggregates: emptyFamily(),
    reason: null,
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

  if (!status.status.cutovers.publicProjections) {
    summary.checked = 0;
    summary.gateState = "disabled";
    summary.produced = 0;
    summary.reason = "public_projection_cutover_disabled";
    return summary;
  }

  summary.checked = 2;
  summary.gateState = "active";
  const aggregates = status.status.projections.publicAggregates;
  if (needsRepair(aggregates) || !aggregates.anchorsReady) {
    summary.publicAggregates = advanceFamily(run, "public_aggregates");
  } else {
    summary.publicAggregates.complete = true;
  }

  const artists = status.status.projections.artistQualification;
  if (needsRepair(artists)) {
    summary.artistQualification = advanceFamily(run, "artist_qualification");
  } else {
    summary.artistQualification.complete = true;
  }

  summary.errors = [summary.publicAggregates, summary.artistQualification].filter(
    (family) => family.error !== null,
  ).length;
  summary.ok = summary.errors === 0;
  summary.produced =
    summary.errors === 0
      ? (summary.publicAggregates.processed ?? 0) + (summary.artistQualification.processed ?? 0)
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
