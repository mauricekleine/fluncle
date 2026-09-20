import { PROJECTION_STEP_LIMIT_MAX } from "@fluncle/contracts/orpc";

import { adminApiGet, adminApiPost, adminApiPut } from "../api";

export { PROJECTION_STEP_LIMIT_MAX };
export const PROJECTION_MAX_STEPS = 100;

/**
 * Bounds on `--wall-ms`, the wall budget an advance invocation may spend issuing steps.
 *
 * A step is one HTTP round trip, so a step count is a poor proxy for how long an invocation runs:
 * the same ceiling costs a second against a warm database and minutes against a loaded one. A
 * caller that must return inside a deadline of its own — the box maintenance sweep runs each family
 * under a child-process deadline — states that deadline here instead of guessing a step count from
 * an assumed per-step cost. The step ceiling stays the hard cap on requests issued.
 */
export const PROJECTION_WALL_MS_MIN = 1_000;
export const PROJECTION_WALL_MS_MAX = 600_000;

export type ProjectionTarget =
  | "artist_qualification"
  | "crawl_due_work"
  | "public_aggregates"
  | "track_due_work";
export type ProjectionCutover = "crawl_due_work" | "public_projections" | "track_due_work";
export type ProjectionAction = "audit" | "rebuild" | "repair";

type FamilyStatus = {
  backlog: {
    leased: { count: number; truncated: boolean };
    ready: { count: number; truncated: boolean };
    scheduled: { count: number; truncated: boolean };
  };
  convergence: {
    digestMatched: boolean | null;
    epochMatched: boolean | null;
    projectedDigest: null | string;
    projectedEpoch: null | number;
    sourceDigest: null | string;
    sourceEpoch: null | number;
  };
  oldestOutstandingMarkerAge: {
    ageMs: number | null;
    reason: "marker_timestamp_invalid" | "marker_timestamp_unavailable" | null;
    truncated: boolean;
  };
  ready: boolean;
  rebuild: {
    complete: boolean;
    completed: number;
    projected: number;
    running: number;
    scanned: number;
    total: number;
  };
  repairs: {
    direct: { count: number; truncated: boolean };
    fanout: { count: number; truncated: boolean };
    total: { count: number; truncated: boolean };
  };
};

export type ProjectionStatus = {
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
  readyToOpen: {
    crawlDueWork: boolean;
    publicProjections: boolean;
    trackDueWork: boolean;
  };
};

export type ProjectionStatusResponse = { ok: true; status: ProjectionStatus };
export type ProjectionStepResponse = {
  action: ProjectionAction;
  complete: boolean;
  ok: true;
  processed: number;
  scheduled: number;
  status?: ProjectionStatus;
  target: ProjectionTarget;
};
type ProjectionAdvanceSummary = Omit<ProjectionStepResponse, "status"> & {
  steps: number;
  /**
   * Whether the wall budget, rather than completion or the step ceiling, ended the step sequence.
   * It is the difference between "this family is drained" and "this family has more to drain", so
   * an automated caller can report an honest incomplete result instead of an error.
   */
  wallStopped: boolean;
};
export type ProjectionAdvanceResponse = ProjectionAdvanceSummary & {
  status: ProjectionStatus;
};
export type ProjectionAdvanceWithoutStatusResponse = ProjectionAdvanceSummary & { status?: never };

type ProjectionAdvanceInput = {
  action: ProjectionAction;
  includeTerminalStatus?: boolean;
  limit: number;
  maxSteps?: number;
  now?: () => number;
  target: ProjectionTarget;
  wallMs?: number;
};

export async function getProjectionStatusCommand(): Promise<ProjectionStatusResponse> {
  return adminApiGet<ProjectionStatusResponse>("/api/v1/admin/projections/status");
}

export function advanceProjectionCommand(
  input: ProjectionAdvanceInput & { includeTerminalStatus: false },
): Promise<ProjectionAdvanceWithoutStatusResponse>;
export function advanceProjectionCommand(
  input: ProjectionAdvanceInput & { includeTerminalStatus?: true },
): Promise<ProjectionAdvanceResponse>;
export function advanceProjectionCommand(
  input: ProjectionAdvanceInput,
): Promise<ProjectionAdvanceResponse | ProjectionAdvanceWithoutStatusResponse>;
export async function advanceProjectionCommand(
  input: ProjectionAdvanceInput,
): Promise<ProjectionAdvanceResponse | ProjectionAdvanceWithoutStatusResponse> {
  const {
    includeTerminalStatus = true,
    maxSteps = 1,
    now = () => Date.now(),
    target,
    wallMs,
    ...body
  } = input;
  if (!includeTerminalStatus && input.action !== "repair") {
    throw new Error("terminal status may be omitted only for repair automation");
  }
  const stepBody =
    maxSteps > 1 || !includeTerminalStatus ? { ...body, includeStatus: false } : body;
  // The first step always runs, whatever the budget: an invocation that issued no request at all
  // would report a step sequence it never attempted, and its caller would read zero progress as a
  // drained family. The budget bounds what FOLLOWS a step, never a step already in flight.
  const startedAt = now();
  let response = await adminApiPost<ProjectionStepResponse>(
    `/api/v1/admin/projections/${target}/advance`,
    stepBody,
  );
  let steps = 1;
  let processed = response.processed;
  let scheduled = response.scheduled;
  let wallStopped = false;

  while (!response.complete && steps < maxSteps) {
    if (wallMs !== undefined && now() - startedAt >= wallMs) {
      wallStopped = true;
      break;
    }
    response = await adminApiPost<ProjectionStepResponse>(
      `/api/v1/admin/projections/${target}/advance`,
      stepBody,
    );
    steps += 1;
    processed += response.processed;
    scheduled += response.scheduled;
  }

  if (!includeTerminalStatus) {
    const { status: _status, ...withoutStatus } = response;
    return { ...withoutStatus, processed, scheduled, steps, wallStopped };
  }
  const status = response.status ?? (await getProjectionStatusCommand()).status;
  return { ...response, processed, scheduled, status, steps, wallStopped };
}

export async function setProjectionCutoverCommand(input: {
  enabled: boolean;
  target: ProjectionCutover;
}): Promise<ProjectionStatusResponse & { enabled: boolean; target: ProjectionCutover }> {
  const { enabled, target } = input;
  return adminApiPut<ProjectionStatusResponse & { enabled: boolean; target: ProjectionCutover }>(
    `/api/v1/admin/projections/${target}/cutover`,
    { enabled },
  );
}

export function parseProjectionEnabled(value: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error("--enabled must be true or false");
  }
  return value === "true";
}

export function parseProjectionLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROJECTION_STEP_LIMIT_MAX) {
    throw new Error(`--limit must be a whole number from 1 through ${PROJECTION_STEP_LIMIT_MAX}`);
  }
  return limit;
}

export function parseProjectionMaxSteps(value: string): number {
  const maxSteps = Number(value);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > PROJECTION_MAX_STEPS) {
    throw new Error(`--max-steps must be a whole number from 1 through ${PROJECTION_MAX_STEPS}`);
  }
  return maxSteps;
}

export function parseProjectionWallMs(value: string): number {
  const wallMs = Number(value);
  if (
    !Number.isSafeInteger(wallMs) ||
    wallMs < PROJECTION_WALL_MS_MIN ||
    wallMs > PROJECTION_WALL_MS_MAX
  ) {
    throw new Error(
      `--wall-ms must be a whole number of milliseconds from ${PROJECTION_WALL_MS_MIN} through ${PROJECTION_WALL_MS_MAX}`,
    );
  }
  return wallMs;
}

export function parseProjectionTarget(value: string): ProjectionTarget {
  if (
    value !== "artist_qualification" &&
    value !== "crawl_due_work" &&
    value !== "public_aggregates" &&
    value !== "track_due_work"
  ) {
    throw new Error(
      "--target must be artist_qualification, crawl_due_work, public_aggregates, or track_due_work",
    );
  }
  return value;
}

export function parseProjectionCutover(value: string): ProjectionCutover {
  if (value !== "crawl_due_work" && value !== "public_projections" && value !== "track_due_work") {
    throw new Error("--target must be crawl_due_work, public_projections, or track_due_work");
  }
  return value;
}

export function parseProjectionAction(value: string): ProjectionAction {
  if (value !== "audit" && value !== "rebuild" && value !== "repair") {
    throw new Error("--action must be audit, rebuild, or repair");
  }
  return value;
}

export function projectionStatusLines(status: ProjectionStatus): string[] {
  const row = (name: string, family: FamilyStatus, enabled: boolean) =>
    `${name}: ${family.ready ? "ready" : "not ready"}; cutover ${enabled ? "open" : "dark"}; rebuild ${family.rebuild.completed}/${family.rebuild.total}; repairs ${family.repairs.total.count}${family.repairs.total.truncated ? "+" : ""}.`;
  return [
    row("Track due-work", status.projections.trackDueWork, status.cutovers.trackDueWork),
    row("Crawl due-work", status.projections.crawlDueWork, status.cutovers.crawlDueWork),
    row(
      "Public aggregates",
      status.projections.publicAggregates,
      status.cutovers.publicProjections,
    ),
    row(
      "Artist qualification",
      status.projections.artistQualification,
      status.cutovers.publicProjections,
    ),
  ];
}
