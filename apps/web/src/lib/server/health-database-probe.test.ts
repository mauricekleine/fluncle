import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  workerDatabaseConcurrencyGate,
  WORKER_DB_AGGREGATE_CONCURRENCY,
} from "../database-concurrency";
import { HEALTH_DATABASE_BUDGET_MS, probeHealthDatabase } from "./health-database-probe";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@libsql/client/web", () => ({ createClient: () => ({ execute }) }));
vi.mock("./env", () => ({
  readEnvs: async () => ({
    TURSO_AUTH_TOKEN: "test",
    TURSO_DATABASE_URL: "libsql://example.invalid",
  }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  execute.mockReset().mockResolvedValue({ rows: [{ "1": 1 }] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("primary database health", () => {
  it("reports a successful primary read and releases its admission", async () => {
    expect(await probeHealthDatabase()).toEqual({ latencyMs: 0, queueWaitMs: 0, status: "ok" });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ sql: "select 1" }));
    expect(console.warn).not.toHaveBeenCalled();
    expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
  });

  it("reports degraded when admission waited noticeably", async () => {
    const held = await Promise.all(
      Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY }, () =>
        workerDatabaseConcurrencyGate.acquire("write"),
      ),
    );
    try {
      const pending = probeHealthDatabase();
      await vi.advanceTimersByTimeAsync(500);
      expect(execute).not.toHaveBeenCalled();
      held[0]?.release();
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toMatchObject({ queueWaitMs: expect.any(Number), status: "degraded" });
      expect((await pending).queueWaitMs).toBeGreaterThanOrEqual(500);
    } finally {
      held.forEach((lease) => lease.release());
    }
  });

  it.each([999, 1000])(
    "classifies a successful %ims read at the latency boundary",
    async (latencyMs) => {
      execute.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ rows: [] }), latencyMs)),
      );
      const pending = probeHealthDatabase();
      await vi.advanceTimersByTimeAsync(latencyMs);
      expect(await pending).toEqual({
        latencyMs,
        queueWaitMs: 0,
        status: latencyMs < 1000 ? "ok" : "degraded",
      });
    },
  );

  it("reports down on a database error with a warning", async () => {
    execute.mockRejectedValue(new Error("private database detail"));
    expect(await probeHealthDatabase()).toEqual({ latencyMs: 0, queueWaitMs: 0, status: "down" });
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("reports down when completion exceeds the budget before its deadline timer runs", async () => {
    execute.mockImplementation(async () => {
      vi.setSystemTime(HEALTH_DATABASE_BUDGET_MS);
      return { rows: [] };
    });
    expect(await probeHealthDatabase()).toEqual({
      latencyMs: 2500,
      queueWaitMs: 0,
      status: "down",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a pending admission and never starts it after the deadline", async () => {
    const held = await Promise.all(
      Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY }, () =>
        workerDatabaseConcurrencyGate.acquire("write"),
      ),
    );
    try {
      const pending = probeHealthDatabase();
      await vi.advanceTimersByTimeAsync(HEALTH_DATABASE_BUDGET_MS);
      expect(await pending).toEqual({ latencyMs: 2500, queueWaitMs: null, status: "down" });
      held.forEach((lease) => lease.release());
      await vi.advanceTimersByTimeAsync(100);
      expect(execute).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
    } finally {
      held.forEach((lease) => lease.release());
    }
  });

  it.each(["success", "gateway-error"])(
    "bounds execution and releases admission after a late %s without starting another query",
    async (outcome) => {
      let settle: (() => void) | undefined;
      execute.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              outcome === "success" ? resolve({ rows: [] }) : reject({ status: 502 });
          }),
      );
      const pending = probeHealthDatabase();
      await vi.advanceTimersByTimeAsync(HEALTH_DATABASE_BUDGET_MS);
      expect(await pending).toEqual({ latencyMs: 2500, queueWaitMs: 0, status: "down" });
      expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(1);
      settle?.();
      await vi.advanceTimersByTimeAsync(500);
      expect(execute).toHaveBeenCalledOnce();
      expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
    },
  );
});
