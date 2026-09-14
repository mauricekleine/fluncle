// due-work-repair-pending.ts — the one recognizer for the Worker's typed "due-work repair is still
// converging" answer, shared by every sweep whose queue read or claim passes the due-work read guard.
//
// THE CONTRACT. A guarded due-work read first runs one bounded source-repair step. While more repair
// remains than that step converges, the Worker refuses the read with HTTP 503 and the stable body code
// `due_work_maintenance_pending` inside its `{ code, message, ok: false }` error envelope. The refused
// read still advanced its repair step, so the next tick reads again. The `fluncle` CLI keeps that body
// code verbatim in its own `--json` failure payload.
//
// THE OUTCOME. Meeting that answer is designed backpressure, never a run failure: the sweep stops the
// affected work cleanly, exits zero, and reports `gateState: "paused"`, `throttled: true`, and
// `reason: "due_work_repair_pending"` — the same gate and backpressure fields a database-admission
// phase yield carries. Work measured before the pause keeps its counts and marks the run `partial`.
// A refused read ends that read for the tick; a sweep never re-asks the same queue in-tick.
//
// RECOGNITION KEYS ON THE TYPED CODE ONLY. A generic 500, a 503 with any other code, and a malformed
// body stay ordinary failures, so a broken Worker can never read as a paused fleet.
//
// Box scripts cannot import the workspace, and `render-conductor.sh` cannot import this module; it
// mirrors the code and reason literals, pinned in lockstep by due-work-repair-pending.test.ts.

export const DUE_WORK_MAINTENANCE_PENDING_CODE = "due_work_maintenance_pending";
export const DUE_WORK_MAINTENANCE_PENDING_STATUS = 503;
export const DUE_WORK_REPAIR_PENDING_REASON = "due_work_repair_pending";

/** The run-level fields every summary paused on the due-work repair carries. */
export type DueWorkRepairPendingGate = {
  gateState: "paused";
  partial: boolean;
  reason: typeof DUE_WORK_REPAIR_PENDING_REASON;
  throttled: true;
};

/** Thrown by a queue read or claim the Worker deferred; callers convert it into the paused outcome. */
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

/** Direct HTTP: exactly the Worker's typed 503 body. */
export function isDueWorkMaintenancePendingResponse(status: number, body: string): boolean {
  return (
    status === DUE_WORK_MAINTENANCE_PENDING_STATUS &&
    jsonObject(body)?.code === DUE_WORK_MAINTENANCE_PENDING_CODE
  );
}

/**
 * The `fluncle … --json` CLI: a non-zero exit whose stdout is the CLI's `{ code, message, ok: false }`
 * failure payload carrying the typed code. The CLI surfaces the Worker's body code unchanged and a
 * generic Worker fault reaches it as `error`, so the typed code alone identifies the typed 503.
 */
export function isDueWorkMaintenancePendingCliFailure(exitCode: number, stdout: string): boolean {
  if (exitCode === 0) {
    return false;
  }

  const payload = jsonObject(stdout);

  return payload?.ok === false && payload.code === DUE_WORK_MAINTENANCE_PENDING_CODE;
}

/**
 * Read a non-OK direct-HTTP response's body for the caller's own failure message, throwing
 * {@link DueWorkRepairPendingError} instead when the body is the typed pending answer. Consumes the
 * body.
 */
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

/** Throw {@link DueWorkRepairPendingError} when a failed CLI command printed the typed answer. */
export function throwIfCliRepairPending(operation: string, exitCode: number, stdout: string): void {
  if (isDueWorkMaintenancePendingCliFailure(exitCode, stdout)) {
    throw new DueWorkRepairPendingError(operation);
  }
}

function measuredWork(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

/**
 * The gate fields for a summary the repair paused. `partial` is true when the summary already
 * measured work (`checked` or `produced` above zero) before the pause, so those counts stay real.
 */
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

/**
 * A summary for a tick the repair paused: no run error and no produced work unless the caller's
 * fields measured some. The gate fields land last, so no caller field can override them.
 */
export function dueWorkRepairPendingSummary(
  fields: Record<string, unknown> = {},
): Record<string, unknown> & DueWorkRepairPendingGate {
  const summary: Record<string, unknown> = { errors: 0, ok: true, produced: 0, ...fields };

  return { ...summary, ...dueWorkRepairPendingGate(summary) };
}
