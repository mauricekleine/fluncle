export const DUE_WORK_MAINTENANCE_PENDING_CODE = "due_work_maintenance_pending";
export const DUE_WORK_MAINTENANCE_PENDING_STATUS = 503;
export const DUE_WORK_REPAIR_PENDING_REASON = "due_work_repair_pending";

export type DueWorkRepairPendingGate = {
  gateState: "paused";
  partial: boolean;
  reason: typeof DUE_WORK_REPAIR_PENDING_REASON;
  throttled: true;
};

export class DueWorkRepairPendingError extends Error {
  constructor(operation: string) {
    super(`${operation} deferred: due-work repair is still converging`);
    this.name = "DueWorkRepairPendingError";
  }
}

export function isDueWorkRepairPending(error: unknown): error is DueWorkRepairPendingError {
  return error instanceof DueWorkRepairPendingError;
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function isDueWorkMaintenancePendingResponse(status: number, body: string): boolean {
  return (
    status === DUE_WORK_MAINTENANCE_PENDING_STATUS &&
    jsonObject(body)?.code === DUE_WORK_MAINTENANCE_PENDING_CODE
  );
}

export function isDueWorkMaintenancePendingCliFailure(exitCode: number, stdout: string): boolean {
  if (exitCode === 0) {
    return false;
  }

  const payload = jsonObject(stdout);

  return payload?.ok === false && payload.code === DUE_WORK_MAINTENANCE_PENDING_CODE;
}

export async function failureBodyUnlessRepairPending(
  response: Response,
  operation: string,
): Promise<string> {
  const body = await response.text();

  if (isDueWorkMaintenancePendingResponse(response.status, body)) {
    throw new DueWorkRepairPendingError(operation);
  }

  return body;
}

export function throwIfPageRepairPending(operation: string, payload: unknown): void {
  const page = jsonObject(typeof payload === "string" ? payload : JSON.stringify(payload));

  if (page?.debtPending === true) {
    throw new DueWorkRepairPendingError(operation);
  }
}

export function throwIfCliRepairPending(operation: string, exitCode: number, stdout: string): void {
  if (isDueWorkMaintenancePendingCliFailure(exitCode, stdout)) {
    throw new DueWorkRepairPendingError(operation);
  }
}

function measuredWork(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

export function dueWorkRepairPendingGate(measured: {
  checked?: unknown;
  produced?: unknown;
}): DueWorkRepairPendingGate {
  return {
    gateState: "paused",
    partial: measuredWork(measured.checked) || measuredWork(measured.produced),
    reason: DUE_WORK_REPAIR_PENDING_REASON,
    throttled: true,
  };
}

export function dueWorkRepairPendingSummary(
  fields: Record<string, unknown> = {},
): Record<string, unknown> & DueWorkRepairPendingGate {
  const summary: Record<string, unknown> = { errors: 0, ok: true, produced: 0, ...fields };

  return { ...summary, ...dueWorkRepairPendingGate(summary) };
}
