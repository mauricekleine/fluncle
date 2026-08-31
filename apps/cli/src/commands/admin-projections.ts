import { PROJECTION_STEP_LIMIT_MAX } from "@fluncle/contracts/orpc";

import { adminApiGet, adminApiPost, adminApiPut } from "../api";

export { PROJECTION_STEP_LIMIT_MAX };
export const PROJECTION_MAX_STEPS = 100;

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
    trackDueWork: FamilyStatus;
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
export type ProjectionAdvanceResponse = Omit<ProjectionStepResponse, "status"> & {
  status: ProjectionStatus;
  steps: number;
};

export async function getProjectionStatusCommand(): Promise<ProjectionStatusResponse> {
  return adminApiGet<ProjectionStatusResponse>("/api/v1/admin/projections/status");
}

export async function advanceProjectionCommand(input: {
  action: ProjectionAction;
  limit: number;
  maxSteps?: number;
  target: ProjectionTarget;
}): Promise<ProjectionAdvanceResponse> {
  const { maxSteps = 1, target, ...body } = input;
  const stepBody = maxSteps > 1 ? { ...body, includeStatus: false } : body;
  let response = await adminApiPost<ProjectionStepResponse>(
    `/api/v1/admin/projections/${target}/advance`,
    stepBody,
  );
  let steps = 1;
  let processed = response.processed;
  let scheduled = response.scheduled;

  while (!response.complete && steps < maxSteps) {
    response = await adminApiPost<ProjectionStepResponse>(
      `/api/v1/admin/projections/${target}/advance`,
      stepBody,
    );
    steps += 1;
    processed += response.processed;
    scheduled += response.scheduled;
  }

  const status = response.status ?? (await getProjectionStatusCommand()).status;
  return { ...response, processed, scheduled, status, steps };
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
