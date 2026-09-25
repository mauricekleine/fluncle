import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DUE_WORK_MAINTENANCE_PENDING_CODE,
  DUE_WORK_REPAIR_PENDING_REASON,
  DueWorkRepairPendingError,
  dueWorkRepairPendingGate,
  dueWorkRepairPendingSummary,
  failureBodyUnlessRepairPending,
  isDueWorkMaintenancePendingCliFailure,
  isDueWorkMaintenancePendingResponse,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
  throwIfPageRepairPending,
} from "./due-work-repair-pending";

const TYPED_PENDING_BODY = JSON.stringify({
  code: "due_work_maintenance_pending",
  message: "Due-work maintenance is still converging",
  ok: false,
});

const GENERIC_FAULT_BODY = JSON.stringify({
  code: "error",
  message: "Internal error",
  ok: false,
});

describe("direct HTTP recognition", () => {
  test("recognizes exactly the typed 503", () => {
    expect(isDueWorkMaintenancePendingResponse(503, TYPED_PENDING_BODY)).toBe(true);
  });

  test("a generic 500 is never pending", () => {
    expect(isDueWorkMaintenancePendingResponse(500, GENERIC_FAULT_BODY)).toBe(false);
  });

  test("the typed code on any status but 503 is never pending", () => {
    expect(isDueWorkMaintenancePendingResponse(500, TYPED_PENDING_BODY)).toBe(false);
  });

  test("a 503 with another code or a malformed body is never pending", () => {
    expect(isDueWorkMaintenancePendingResponse(503, GENERIC_FAULT_BODY)).toBe(false);
    expect(isDueWorkMaintenancePendingResponse(503, "Service Unavailable")).toBe(false);
    expect(isDueWorkMaintenancePendingResponse(503, "[]")).toBe(false);
  });

  test("failureBodyUnlessRepairPending throws the typed pause and returns every other body", async () => {
    let thrown: unknown;
    try {
      await failureBodyUnlessRepairPending(
        new Response(TYPED_PENDING_BODY, { status: 503 }),
        "queue read",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DueWorkRepairPendingError);

    const generic = await failureBodyUnlessRepairPending(
      new Response(GENERIC_FAULT_BODY, { status: 500 }),
      "queue read",
    );
    expect(generic).toBe(GENERIC_FAULT_BODY);
  });
});

describe("CLI recognition", () => {
  test("recognizes a failed command whose JSON payload carries the typed code", () => {
    expect(isDueWorkMaintenancePendingCliFailure(1, `${TYPED_PENDING_BODY}\n`)).toBe(true);

    expect(
      isDueWorkMaintenancePendingCliFailure(
        1,
        JSON.stringify(JSON.parse(TYPED_PENDING_BODY), null, 2),
      ),
    ).toBe(true);
  });

  test("a generic fault, a status-line fallback, a crash, and a success are never pending", () => {
    expect(isDueWorkMaintenancePendingCliFailure(1, GENERIC_FAULT_BODY)).toBe(false);
    expect(
      isDueWorkMaintenancePendingCliFailure(
        1,
        JSON.stringify({ code: "http_503", message: "503 Service Unavailable", ok: false }),
      ),
    ).toBe(false);
    expect(isDueWorkMaintenancePendingCliFailure(1, "boom")).toBe(false);
    expect(isDueWorkMaintenancePendingCliFailure(0, TYPED_PENDING_BODY)).toBe(false);
  });

  test("throwIfCliRepairPending throws only the typed pause", () => {
    expect(() => throwIfCliRepairPending("fluncle admin x", 1, TYPED_PENDING_BODY)).toThrow(
      DueWorkRepairPendingError,
    );
    expect(() => throwIfCliRepairPending("fluncle admin x", 1, GENERIC_FAULT_BODY)).not.toThrow();

    try {
      throwIfCliRepairPending("fluncle admin x", 1, TYPED_PENDING_BODY);
    } catch (error) {
      expect(isDueWorkRepairPending(error)).toBe(true);
      expect(isDueWorkRepairPending(new Error("other"))).toBe(false);
    }
  });
});

describe("the paused outcome", () => {
  test("a whole-tick pause is exit-zero backpressure with no produced work", () => {
    expect(dueWorkRepairPendingSummary({ checked: 0, queueDepth: null })).toEqual({
      checked: 0,
      errors: 0,
      gateState: "paused",
      ok: true,
      partial: false,
      produced: 0,
      queueDepth: null,
      reason: DUE_WORK_REPAIR_PENDING_REASON,
      throttled: true,
    });
  });

  test("a mid-batch pause keeps the measured counts and marks the run partial", () => {
    const summary = dueWorkRepairPendingSummary({
      checked: 4,
      failed: 1,
      produced: 3,
      reason: null,
      throttled: false,
    });

    expect(summary).toMatchObject({
      checked: 4,
      errors: 0,
      failed: 1,
      gateState: "paused",
      ok: true,
      partial: true,
      produced: 3,
      reason: DUE_WORK_REPAIR_PENDING_REASON,
      throttled: true,
    });
  });

  test("the gate alone reports partial from checked or produced", () => {
    expect(dueWorkRepairPendingGate({ checked: 0, produced: 0 }).partial).toBe(false);
    expect(dueWorkRepairPendingGate({ checked: 2, produced: 0 }).partial).toBe(true);
    expect(dueWorkRepairPendingGate({ checked: null, produced: 1 }).partial).toBe(true);
  });
});

describe("a withheld page inside an OK response", () => {
  test("pauses on debtPending, whatever the count beside it says", () => {
    expect(() =>
      throwIfPageRepairPending("embed queue read", {
        debtPending: true,
        queued: 4_812,
        tracks: [],
      }),
    ).toThrow(DueWorkRepairPendingError);
  });

  test("an honestly empty page is not a pause", () => {
    expect(() =>
      throwIfPageRepairPending("embed queue read", { queued: 0, tracks: [] }),
    ).not.toThrow();
    expect(() =>
      throwIfPageRepairPending("embed queue read", { debtPending: false, queued: 0, tracks: [] }),
    ).not.toThrow();
  });

  test("a served page is not a pause even when debt exists elsewhere", () => {
    expect(() =>
      throwIfPageRepairPending("embed queue read", { queued: 4_812, tracks: [{ trackId: "t" }] }),
    ).not.toThrow();
  });

  test("a malformed or non-object body stays an ordinary read, never a pause", () => {
    for (const payload of [undefined, null, "not-json", 7, []]) {
      expect(() => throwIfPageRepairPending("embed queue read", payload)).not.toThrow();
    }
  });
});

describe("the shell mirror", () => {
  test("render-conductor.sh carries the same code and reason literals", () => {
    const conductor = readFileSync(join(import.meta.dir, "render-conductor.sh"), "utf8");

    expect(conductor).toContain(DUE_WORK_MAINTENANCE_PENDING_CODE);
    expect(conductor).toContain(DUE_WORK_REPAIR_PENDING_REASON);
  });
});
