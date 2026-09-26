#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const REPAIR_LIMIT = 500;

const PROJECTION_MAX_STEPS = 100;

const STEPS_HEADROOM = 1;

const DUE_WORK_MARKERS_PER_STEP = 5;

const PUBLIC_SUBJECTS_PER_STEP = REPAIR_LIMIT;

const PUBLIC_MIN_STEPS = 4;

const DEBT_AGE_ESCALATION_MS = 60 * 60_000;

const RUN_WALL_BUDGET_MS = 120_000;

const FAMILY_CALL_BUDGET_MS = 30_000;

const MIN_FAMILY_CALL_BUDGET_MS = 5_000;

const CLI_CALL_TIMEOUT_MS = 60_000;

const LEGACY_SAFE_MAX_STEPS = 30;

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
      publicAggregates: FamilyStatus & { anchorsReady: boolean; durationGenerationReady: boolean };
      trackDueWork: FamilyStatus & { catalogueRankMarkerAgeMs?: null | number };
    };
  };
};
type AdvanceResponse = {
  action: "repair";
  complete: boolean;
  ok: true;
  processed: number;

  rebuildRowsWalked?: number;
  rebuildStaleFamilies?: number;
  scheduled: number;
  steps: number;
  target: FamilyName;

  wallStopped?: boolean;
};

export type FamilySummary = {
  attempted: boolean;
  complete: boolean | null;
  error: string | null;

  leaseHoldMs: number | null;
  oldestOutstandingMarkerAge: OldestOutstandingMarkerAge | null;
  outcome: ProjectionMaintenanceOutcome | null;
  processed: number | null;

  rebuildRowsWalked: number | null;

  rebuildStaleFamilies: number | null;
  scheduled: number | null;
  steps: number | null;

  wallBound: "steps" | "wall-ms" | null;

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

  totalLeaseHoldMs: number;
  trackDueWork: FamilySummary;

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
    typeof projections["publicAggregates"]["durationGenerationReady"] !== "boolean" ||
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

export class CliTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`fluncle ${command} exceeded its ${timeoutMs}ms deadline and was killed`);
    this.name = "CliTimeoutError";
  }
}

export function fluncleJson(args: string[], timeoutMs: number = CLI_CALL_TIMEOUT_MS): unknown {
  const fluncleBin = process.env.FLUNCLE_BIN ?? "fluncle";
  const result = spawnSync(fluncleBin, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });

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

function dueWorkNeedsAdvance(family: FamilyStatus): boolean {
  return hasRepairDebt(family) || family.rebuild?.complete === false;
}

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

export function familyWallBudgetMs(remainingMs: number): number {
  if (remainingMs < MIN_FAMILY_CALL_BUDGET_MS) {
    return 0;
  }
  return Math.min(remainingMs, FAMILY_CALL_BUDGET_MS);
}

export function oldestDebtFirst<Family extends { ageMs: number | null }>(
  families: readonly Family[],
): Family[] {
  return [...families].sort((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1));
}

function wallDeferredFamily(oldestOutstandingMarkerAge: OldestOutstandingMarkerAge): FamilySummary {
  return { ...emptyFamily(), complete: false, oldestOutstandingMarkerAge };
}

function advanceFamily(
  run: RunCommand,
  target: FamilyName,
  maxSteps: number,
  wallMs: number | null,
  oldestOutstandingMarkerAge: OldestOutstandingMarkerAge,
  now: () => number,
): FamilySummary {
  const wallBound = wallMs === null ? "steps" : "wall-ms";

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

      wallStopped: wallMs === null ? null : (response.wallStopped ?? false),
    };
  } catch (error) {
    return {
      attempted: true,
      complete: false,
      error: error instanceof Error ? error.message : String(error),
      leaseHoldMs: now() - startedAt,
      oldestOutstandingMarkerAge,

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

export function runProjectionMaintenanceTick(
  run: RunCommand = fluncleJson,
  options: { acceptsWallMs?: () => boolean; now?: () => number } = {},
): ProjectionMaintenanceSummary {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

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
      repairNeeded:
        needsRepair(aggregates) || !aggregates.anchorsReady || !aggregates.durationGenerationReady,
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
