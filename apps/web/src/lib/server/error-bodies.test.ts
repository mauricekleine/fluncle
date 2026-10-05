import { ORPCError } from "@orpc/server";
import * as Sentry from "@sentry/cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_DB_QUEUE_WAIT_MAX_MS,
  WorkerDatabaseConcurrencyGate,
} from "../database-concurrency";
import { DueWorkMaintenancePendingError } from "./due-work";
import { apiErrorResponse } from "./http-errors";
import { apiFault, type ApiFaultData, isApiFaultData } from "./orpc/_shared";
import { ApiError } from "./api-error";

vi.mock("@sentry/cloudflare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/cloudflare")>()),
  captureException: vi.fn(),
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("apiFault — the oRPC catch converter", () => {
  it("maps a database queue timeout to database_busy 503 without capturing an unexpected fault", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sentrySpy = vi.mocked(Sentry.captureException);
    sentrySpy.mockClear();
    const gate = new WorkerDatabaseConcurrencyGate(1);
    const held = await gate.acquire("write");
    const rejected = vi.fn();
    const pending = gate.acquire("read").catch((error: unknown) => {
      rejected();
      return error;
    });

    await vi.advanceTimersByTimeAsync(WORKER_DB_QUEUE_WAIT_MAX_MS - 1);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toHaveBeenCalledOnce();
    const error = await pending;
    expect(error).toBeInstanceOf(ApiError);
    const fault = apiFault(error);
    expect(fault.status).toBe(503);
    expect(fault.data).toMatchObject({ apiCode: "database_busy" });
    expect(errSpy).not.toHaveBeenCalled();
    expect(sentrySpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      accessClass: "read",
      event: "database.admission-timeout",
      queueWaitMs: WORKER_DB_QUEUE_WAIT_MAX_MS,
    });
    expect(gate.snapshot().aggregateInFlight).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    held.release();
    expect(gate.snapshot().aggregateInFlight).toBe(0);
    const next = await gate.acquire("read");
    expect(next.queueWaitMs).toBe(0);
    next.release();
  });

  it("maps expected due-work convergence to a quiet typed 503", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sentrySpy = vi.mocked(Sentry.captureException);
    sentrySpy.mockClear();

    const fault = apiFault(new DueWorkMaintenancePendingError("catalogue-rank"));

    expect(fault.status).toBe(503);
    expect(fault.message).toBe("Due-work maintenance is still converging");
    expect(fault.data).toEqual({
      apiCode: "due_work_maintenance_pending",
      apiMessage: "Due-work maintenance is still converging",
    });
    expect(errSpy).not.toHaveBeenCalled();
    expect(sentrySpy).not.toHaveBeenCalled();
  });

  it("genericizes an unexpected fault and never leaks the raw message", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const fault = apiFault(new Error("secret-internal-detail"));

    expect(fault).toBeInstanceOf(ORPCError);
    expect(fault.status).toBe(500);
    expect(fault.message).toBe("Internal error");
    const data = fault.data as ApiFaultData;
    expect(isApiFaultData(data)).toBe(true);
    expect(data).toEqual({ apiCode: "error", apiMessage: "Internal error" });
    expect(JSON.stringify(fault)).not.toContain("secret-internal-detail");

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errSpy.mock.calls[0]?.[0] as string) as {
      error: { message: string; stack: string };
      event: string;
    };
    expect(logged.event).toBe("api.unexpected-fault");
    expect(logged.error.message).toBe("secret-internal-detail");
  });

  it("passes a deliberate ApiError through unchanged (the client contract)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const fault = apiFault(new ApiError("rate_limited", "Slow down there, traveler", 429));

    expect(fault.status).toBe(429);
    expect(fault.message).toBe("Slow down there, traveler");
    expect(fault.data).toEqual({
      apiCode: "rate_limited",
      apiMessage: "Slow down there, traveler",
    });

    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("apiErrorResponse — the legacy file-route converter", () => {
  async function readBody(response: Response) {
    return (await response.json()) as { code: string; message: string; ok: boolean };
  }

  it("genericizes an unexpected fault and never leaks the raw message", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = apiErrorResponse(new Error("secret-internal-detail"));

    expect(response.status).toBe(500);
    const body = await readBody(response);
    expect(body).toEqual({ code: "error", message: "Internal error", ok: false });
    expect(JSON.stringify(body)).not.toContain("secret-internal-detail");
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("passes a deliberate ApiError through unchanged (the client contract)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = apiErrorResponse(new ApiError("note_too_long", "Note must be shorter", 422));

    expect(response.status).toBe(422);
    expect(await readBody(response)).toEqual({
      code: "note_too_long",
      message: "Note must be shorter",
      ok: false,
    });
    expect(errSpy).not.toHaveBeenCalled();
  });
});
