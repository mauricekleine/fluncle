import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WORKER_DB_ADMISSION_POLL_MAX_MS,
  WORKER_DB_AGGREGATE_CONCURRENCY,
  WORKER_DB_LEASE_HOLD_MAX_MS,
  WORKER_DB_QUEUE_WAIT_MAX_MS,
  workerDatabaseConcurrencyGate,
  workerTelemetryDatabaseConcurrencyGate,
} from "../database-concurrency";

const execute = vi.fn();
const batch = vi.fn();
const close = vi.fn();
const transaction = vi.fn();
const createClient = vi.fn(() => ({ batch, close, execute, transaction }));

const spanContexts: Array<{
  attributes?: Record<string, unknown>;
  name: string;
  op?: string;
}> = [];

const spanAttributes: Array<Record<string, unknown>> = [];
const spanEnds: Array<ReturnType<typeof vi.fn>> = [];

vi.mock("@sentry/core", () => {
  const recordSpan = (context: { name: string }) => {
    spanContexts.push(context);

    const recorded: Record<string, unknown> = {};
    spanAttributes.push(recorded);

    const end = vi.fn();
    spanEnds.push(end);
    return {
      end,
      setAttribute: (key: string, value: unknown) => {
        recorded[key] = value;
      },
    };
  };

  return {
    startInactiveSpan: (context: { name: string }) => recordSpan(context),
    startSpan: (context: { name: string }, callback: (span: unknown) => unknown) =>
      callback(recordSpan(context)),
  };
});

vi.mock("@libsql/client/web", () => ({
  createClient,
}));

vi.mock("./env", () => ({
  readEnvs: async () => ({ TURSO_AUTH_TOKEN: "token", TURSO_DATABASE_URL: "libsql://scratch" }),
  readOptionalEnv: async (name: string) =>
    name === "TURSO_TELEMETRY_DATABASE_URL" ? "libsql://scratch-telemetry" : "token",
}));

const { DB_MAX_RETRIES, databaseOperationStatement, getDb, getTelemetryDb } = await import("./db");
const { runWithDatabaseRequestScope } = await import("./database-request-scope");

function gatewayError(status: number) {
  return new Error(`SERVER_ERROR: Server returned HTTP status ${status}`, {
    cause: Object.assign(new Error(`server returned HTTP status ${status}`), { status }),
  });
}

beforeEach(() => {
  execute.mockReset();
  batch.mockReset();
  close.mockReset();
  transaction.mockReset();
  createClient.mockClear();
  spanContexts.length = 0;
  spanAttributes.length = 0;
  spanEnds.length = 0;
});

function waitForAdmissionPoll(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 2);
  });
}

describe("database admission timeout instrumentation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["execute", "batch", "transaction"] as const)(
    "records queue failure telemetry without starting a timed-out %s operation",
    async (operation) => {
      const held = await Promise.all(
        Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY }, () =>
          workerDatabaseConcurrencyGate.acquire("write"),
        ),
      );
      try {
        const db = await getDb();
        const pending = (
          operation === "execute"
            ? db.execute("select 1")
            : operation === "batch"
              ? db.batch(["select 1"], "read")
              : db.transaction("write")
        ).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(WORKER_DB_QUEUE_WAIT_MAX_MS);
        expect(await pending).toMatchObject({ code: "database_busy", status: 503 });
        expect(execute).not.toHaveBeenCalled();
        expect(batch).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        expect(spanAttributes[0]).toMatchObject({
          "fluncle.aggregate_in_flight_max": WORKER_DB_AGGREGATE_CONCURRENCY,
          "fluncle.duration_ms": WORKER_DB_QUEUE_WAIT_MAX_MS,
          "fluncle.outcome": "failure",
          "fluncle.queue_wait_ms": WORKER_DB_QUEUE_WAIT_MAX_MS,
        });
        if (operation === "transaction") {
          expect(spanEnds[0]).toHaveBeenCalledOnce();
        }
      } finally {
        for (const lease of held) {
          lease.release();
        }
      }
      expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
    },
  );
});

describe("request transaction admission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("completes nested work in two transaction-holding request scopes behind a full gate", async () => {
    execute.mockResolvedValue({ rows: [] });
    const opened: Array<{ close: () => void }> = [];
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    transaction.mockImplementation(async () => {
      const tx = { close: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) };
      opened.push(tx);
      if (opened.length === 2) {
        releaseBarrier?.();
      }
      return tx;
    });
    const held = await Promise.all(
      Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY - 2 }, () =>
        workerDatabaseConcurrencyGate.acquire("write"),
      ),
    );
    const completed = vi.fn();
    const pending = Promise.all(
      Array.from({ length: 2 }, () =>
        runWithDatabaseRequestScope(async () => {
          const db = await getDb();
          const tx = await db.transaction("write");
          try {
            await barrier;
            await (await getDb()).execute("select 1");
            await tx.commit();
            completed();
          } finally {
            tx.close();
          }
        }),
      ),
    );
    try {
      await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS * 2);
      expect(completed).toHaveBeenCalledTimes(2);
      await pending;
      expect(execute).toHaveBeenCalledTimes(2);
      expect(spanAttributes).toHaveLength(4);
      expect(spanAttributes.every((attributes) => attributes["fluncle.queue_wait_ms"] === 0)).toBe(
        true,
      );
      expect(
        spanAttributes.every((attributes) => attributes["fluncle.request_in_flight_max"] === 2),
      ).toBe(true);
      expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(held.length);
    } finally {
      for (const tx of opened) {
        tx.close();
      }
      for (const lease of held) {
        lease.release();
      }
      await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
      await pending;
    }
    expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
  });

  it("shares transaction admission with a sibling that queued before the transaction opened", async () => {
    execute.mockResolvedValue({ rows: [] });
    const transactionClose = vi.fn();
    transaction.mockResolvedValue({ close: transactionClose });
    const held = await Promise.all(
      Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY }, () =>
        workerDatabaseConcurrencyGate.acquire("write"),
      ),
    );
    const completed = vi.fn();
    const pending = runWithDatabaseRequestScope(async () => {
      const db = await getDb();
      const opening = db.transaction("write");
      const sibling = db.execute("select 1");
      const tx = await opening;
      try {
        await sibling;
        completed();
      } finally {
        tx.close();
      }
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(transaction).not.toHaveBeenCalled();
      held[0]?.release();
      await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
      expect(transaction).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
      await pending;
      expect(spanAttributes[1]?.["fluncle.queue_wait_ms"]).toBe(0);
    } finally {
      for (const lease of held) {
        lease.release();
      }
      await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
      await pending;
    }
    expect(transactionClose).toHaveBeenCalledOnce();
    expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
  });

  it.each(["execute", "batch"] as const)(
    "retains a borrowed %s slot after its last transaction closes without granting further re-entrancy",
    async (operation) => {
      let settleBorrow: (() => void) | undefined;
      const blocked = new Promise<{ rows: [] }>((resolve) => {
        settleBorrow = () => resolve({ rows: [] });
      });
      if (operation === "execute") {
        execute.mockReturnValueOnce(blocked).mockResolvedValue({ rows: [] });
      } else {
        batch.mockReturnValueOnce(blocked);
        execute.mockResolvedValue({ rows: [] });
      }
      transaction.mockResolvedValue({ close: vi.fn() });
      const held = await Promise.all(
        Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY - 1 }, () =>
          workerDatabaseConcurrencyGate.acquire("write"),
        ),
      );
      try {
        await runWithDatabaseRequestScope(async () => {
          const db = await getDb();
          const tx = await db.transaction("write");
          const borrowing =
            operation === "execute" ? db.execute("select 1") : db.batch(["select 1"], "read");
          tx.close();
          const next = db.execute("select 2");
          try {
            await vi.advanceTimersByTimeAsync(100);
            expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(4);
            expect(execute.mock.calls.map(([statement]) => statement)).not.toContain("select 2");
          } finally {
            settleBorrow?.();
            await borrowing;
            await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
            await next;
          }
          expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(3);
          expect(spanAttributes[1]?.["fluncle.queue_wait_ms"]).toBe(0);
          expect(spanAttributes[2]?.["fluncle.queue_wait_ms"]).toBeGreaterThanOrEqual(100);
        });
      } finally {
        for (const lease of held) {
          lease.release();
        }
      }
      expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
    },
  );

  it("retains a nested transaction's slot when its parent closes before registration", async () => {
    execute.mockResolvedValue({ rows: [] });
    transaction.mockImplementation(async () => ({ close: vi.fn() }));
    const held = await Promise.all(
      Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY - 1 }, () =>
        workerDatabaseConcurrencyGate.acquire("write"),
      ),
    );
    try {
      await runWithDatabaseRequestScope(async () => {
        const db = await getDb();
        const parent = await db.transaction("write");
        const opening = db.transaction("write");
        parent.close();
        const nested = await opening;
        try {
          expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(4);
          await db.execute("select 1");
          expect(spanAttributes[2]?.["fluncle.queue_wait_ms"]).toBe(0);
        } finally {
          nested.close();
        }
        expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(3);
      });
    } finally {
      for (const lease of held) {
        lease.release();
      }
    }
    expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
  });

  it.each(["commit", "rollback", "close", "failure"] as const)(
    "retains admission after the outer transaction finishes by %s until its nested transaction closes",
    async (finish) => {
      execute.mockResolvedValue({ rows: [] });
      batch.mockResolvedValue([{ rows: [] }]);
      transaction.mockImplementation(async () => {
        let closed = false;
        return {
          close: vi.fn(() => {
            closed = true;
          }),
          get closed() {
            return closed;
          },
          commit: vi.fn(async () => {
            closed = true;
          }),
          execute: vi.fn(async () => {
            closed = true;
            throw new Error("Transaction is closed");
          }),
          rollback: vi.fn(async () => {
            closed = true;
          }),
        };
      });
      const held = await Promise.all(
        Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY - 1 }, () =>
          workerDatabaseConcurrencyGate.acquire("write"),
        ),
      );
      try {
        await runWithDatabaseRequestScope(async () => {
          const db = await getDb();
          const outer = await db.transaction("write");
          const inner = await db.transaction("write");
          try {
            expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(4);
            if (finish === "failure") {
              await expect(outer.execute("select 1")).rejects.toThrow("Transaction is closed");
            } else if (finish === "close") {
              outer.close();
            } else {
              await outer[finish]();
            }
            outer.close();
            expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(4);
            await db.batch(["select 1"], "read");
            expect(spanAttributes[2]?.["fluncle.queue_wait_ms"]).toBe(0);
            expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(4);
            inner.close();
            inner.close();
            expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(3);
            const blocker = await workerDatabaseConcurrencyGate.acquire("write");
            const pending = db.execute("select 1");
            try {
              await vi.advanceTimersByTimeAsync(100);
              expect(execute).not.toHaveBeenCalled();
            } finally {
              blocker.release();
              await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
              await pending;
            }
          } finally {
            outer.close();
            inner.close();
          }
        });
      } finally {
        for (const lease of held) {
          lease.release();
        }
      }
      expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
    },
  );

  it("preserves the parent's admission when a nested transaction fails to open", async () => {
    execute.mockResolvedValue({ rows: [] });
    transaction
      .mockResolvedValueOnce({ close: vi.fn() })
      .mockRejectedValueOnce(new Error("Transaction could not open"));
    const held = await Promise.all(
      Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY - 1 }, () =>
        workerDatabaseConcurrencyGate.acquire("write"),
      ),
    );
    try {
      await runWithDatabaseRequestScope(async () => {
        const db = await getDb();
        const parent = await db.transaction("write");
        try {
          await expect(db.transaction("write")).rejects.toThrow("Transaction could not open");
          expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(4);
          await db.execute("select 1");
          expect(spanAttributes[2]?.["fluncle.queue_wait_ms"]).toBe(0);
        } finally {
          parent.close();
        }
        expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(3);
      });
    } finally {
      for (const lease of held) {
        lease.release();
      }
    }
    expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
  });

  it.each(["primary", "telemetry"] as const)(
    "does not borrow a %s transaction's slot for the other database gate",
    async (holdingSlot) => {
      execute.mockResolvedValue({ rows: [] });
      transaction.mockResolvedValue({ close: vi.fn() });
      const otherGate =
        holdingSlot === "primary"
          ? workerTelemetryDatabaseConcurrencyGate
          : workerDatabaseConcurrencyGate;
      const otherCeiling = holdingSlot === "primary" ? 3 : WORKER_DB_AGGREGATE_CONCURRENCY;
      const held = await Promise.all(
        Array.from({ length: otherCeiling }, () => otherGate.acquire("write")),
      );
      try {
        await runWithDatabaseRequestScope(async () => {
          const primary = await getDb();
          const telemetry = await getTelemetryDb();
          if (telemetry === undefined) {
            throw new Error("Telemetry fixture must be configured");
          }
          const holder = holdingSlot === "primary" ? primary : telemetry;
          const other = holdingSlot === "primary" ? telemetry : primary;
          const tx = await holder.transaction("write");
          const pending = other.execute("select 1");
          try {
            await vi.advanceTimersByTimeAsync(100);
            expect(execute).not.toHaveBeenCalled();
            held[0]?.release();
            await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
            await pending;
            expect(execute).toHaveBeenCalledOnce();
            expect(spanAttributes[1]?.["fluncle.queue_wait_ms"]).toBeGreaterThanOrEqual(100);
          } finally {
            tx.close();
            for (const lease of held) {
              lease.release();
            }
            await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
            await pending;
          }
        });
      } finally {
        for (const lease of held) {
          lease.release();
        }
      }
      expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
      expect(workerTelemetryDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
    },
  );

  it("queues behind new owners after its transaction lease is reclaimed", async () => {
    execute.mockResolvedValue({ rows: [] });
    transaction.mockResolvedValue({ close: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runWithDatabaseRequestScope(async () => {
      const db = await getDb();
      const tx = await db.transaction("write");
      vi.setSystemTime(WORKER_DB_LEASE_HOLD_MAX_MS);
      const held = await Promise.all(
        Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY }, () =>
          workerDatabaseConcurrencyGate.acquire("write"),
        ),
      );
      const pending = db.execute("select 1");
      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(execute).not.toHaveBeenCalled();
        held[0]?.release();
        await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
        await pending;
        tx.close();
        expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(3);
      } finally {
        tx.close();
        for (const lease of held) {
          lease.release();
        }
        await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
        await pending;
      }
    });
    expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
  });

  it("queues a request without an open transaction behind a full gate", async () => {
    execute.mockResolvedValue({ rows: [] });
    const held = await Promise.all(
      Array.from({ length: WORKER_DB_AGGREGATE_CONCURRENCY }, () =>
        workerDatabaseConcurrencyGate.acquire("write"),
      ),
    );
    const pending = runWithDatabaseRequestScope(async () => (await getDb()).execute("select 1"));
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(execute).not.toHaveBeenCalled();
      held[0]?.release();
      await vi.advanceTimersByTimeAsync(WORKER_DB_ADMISSION_POLL_MAX_MS);
      await pending;
      expect(execute).toHaveBeenCalledOnce();
      expect(spanAttributes[0]?.["fluncle.queue_wait_ms"]).toBeGreaterThanOrEqual(100);
    } finally {
      for (const lease of held) {
        lease.release();
      }
    }
    expect(workerDatabaseConcurrencyGate.snapshot().aggregateInFlight).toBe(0);
  });
});

describe("getDb instrumentation", () => {
  it("returns the client's execute result unchanged and spans a string query", async () => {
    const result = { rows: [{ id: 1 }] };
    execute.mockResolvedValue(result);

    const db = await getDb();
    const returned = await db.execute("select 1");

    expect(returned).toBe(result);
    expect(execute).toHaveBeenCalledWith("select 1");
    expect(spanContexts).toHaveLength(1);
    expect(spanContexts[0]).toMatchObject({
      attributes: {
        "db.system": "sqlite",
        "fluncle.access_class": "read",
        "fluncle.attempt_count": 1,
        "fluncle.batch_count": 1,
        "fluncle.operation_id": expect.stringMatching(/^db\.read\.[a-z0-9]+$/),
        "fluncle.release": "unknown",
      },
      name: expect.stringMatching(/^db\.query db\.read\.[a-z0-9]+$/),
      op: "db.query",
    });
    expect(spanAttributes[0]).toMatchObject({
      "fluncle.aggregate_in_flight_max": expect.any(Number),
      "fluncle.attempt_count": 1,
      "fluncle.duration_ms": expect.any(Number),
      "fluncle.outcome": "success",
      "fluncle.queue_wait_ms": expect.any(Number),
      "fluncle.request_in_flight_max": expect.any(Number),
    });
  });

  it("shares one client and measures actual fanout across co-called request helpers", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maximum = Math.max(maximum, active);
          releases.push(() => {
            active -= 1;
            resolve({ rows: [] });
          });
        }),
    );

    await runWithDatabaseRequestScope(async () => {
      const clients = await Promise.all([getDb(), getDb(), getDb(), getDb(), getDb(), getDb()]);
      expect(new Set(clients).size).toBe(1);
      expect(createClient).toHaveBeenCalledTimes(1);

      const request = Promise.all(
        clients.map((client) =>
          client.execute(
            databaseOperationStatement("select 1", {
              operationId: "test.request-fanout",
            }),
          ),
        ),
      );

      for (let turn = 0; turn < 20 && execute.mock.calls.length < 4; turn += 1) {
        await Promise.resolve();
      }
      expect(execute).toHaveBeenCalledTimes(4);

      while (releases.length > 0 || execute.mock.calls.length < clients.length) {
        releases.shift()?.();
        await waitForAdmissionPoll();
      }
      await request;
    });

    expect(maximum).toBe(4);
    expect(spanAttributes).toHaveLength(6);
    expect(
      spanAttributes.some((attributes) => attributes["fluncle.request_in_flight_max"] === 4),
    ).toBe(true);
  });

  it("bounds concurrent request scopes at the Worker aggregate ceiling", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maximum = Math.max(maximum, active);
          releases.push(() => {
            active -= 1;
            resolve({ rows: [] });
          });
        }),
    );

    const requests = Array.from({ length: 3 }, () =>
      runWithDatabaseRequestScope(async () => {
        const clients = await Promise.all([getDb(), getDb(), getDb(), getDb()]);
        expect(new Set(clients).size).toBe(1);

        return Promise.all(
          clients.map((client) =>
            client.execute(
              databaseOperationStatement("select 1", {
                operationId: "test.aggregate-read",
              }),
            ),
          ),
        );
      }),
    );

    for (let turn = 0; turn < 20 && execute.mock.calls.length < 4; turn += 1) {
      await Promise.resolve();
    }
    expect(execute).toHaveBeenCalledTimes(4);

    while (releases.length > 0 || execute.mock.calls.length < 12) {
      const release = releases.shift();
      release?.();
      await waitForAdmissionPoll();
    }
    await Promise.all(requests);

    expect(createClient).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(12);
    expect(maximum).toBe(4);
    expect(spanAttributes).toHaveLength(12);
    expect(
      spanAttributes.every(
        (attributes) => Number(attributes["fluncle.aggregate_in_flight_max"]) <= 4,
      ),
    ).toBe(true);
    expect(spanAttributes.every((attributes) => "fluncle.queue_wait_ms" in attributes)).toBe(true);
  });

  it("admits public reads past a queued heavy reader while one heavy reader is held", async () => {
    const pending = new Map<string, () => void>();
    execute.mockImplementation(
      (statement: string | { sql: string }) =>
        new Promise((resolve) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          pending.set(sql, () => resolve({ rows: [] }));
        }),
    );

    const db = await getDb();
    const firstHeavy = db.execute(
      databaseOperationStatement("select 'heavy-one'", {
        accessClass: "heavy-read",
        operationId: "test.heavy-read",
      }),
    );
    await Promise.resolve();
    const secondHeavy = db.execute(
      databaseOperationStatement("select 'heavy-two'", {
        accessClass: "heavy-read",
        operationId: "test.heavy-read",
      }),
    );
    const publicReads = [1, 2, 3].map((index) =>
      db.execute(
        databaseOperationStatement(`select 'public-${index}'`, {
          operationId: "test.public-read",
        }),
      ),
    );

    for (let turn = 0; turn < 20 && execute.mock.calls.length < 4; turn += 1) {
      await Promise.resolve();
    }
    const admittedSql = execute.mock.calls.map(([statement]) =>
      typeof statement === "string" ? statement : statement.sql,
    );
    expect(admittedSql).toEqual([
      "select 'heavy-one'",
      "select 'public-1'",
      "select 'public-2'",
      "select 'public-3'",
    ]);

    pending.get("select 'heavy-one'")?.();
    await firstHeavy;
    await waitForAdmissionPoll();
    expect(execute.mock.calls).toHaveLength(5);
    expect(execute.mock.calls[4]?.[0]).toMatchObject({ sql: "select 'heavy-two'" });

    for (const sql of [
      "select 'heavy-two'",
      "select 'public-1'",
      "select 'public-2'",
      "select 'public-3'",
    ]) {
      pending.get(sql)?.();
    }
    await Promise.all([secondHeavy, ...publicReads]);
  });

  it("holds one aggregate seat for an explicit transaction until it closes", async () => {
    const queryReleases: Array<() => void> = [];
    execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          queryReleases.push(() => resolve({ rows: [] }));
        }),
    );
    const transactionClose = vi.fn();
    transaction.mockResolvedValue({
      batch: vi.fn(),
      close: transactionClose,
      commit: vi.fn(),
      execute: vi.fn(),
      executeMultiple: vi.fn(),
      rollback: vi.fn(),
    });

    const db = await getDb();
    const reads = Array.from({ length: 4 }, () => db.execute("select 1"));
    for (let turn = 0; turn < 20 && execute.mock.calls.length < 4; turn += 1) {
      await Promise.resolve();
    }

    const pendingTransaction = db.transaction("write");
    await Promise.resolve();
    expect(transaction).not.toHaveBeenCalled();

    queryReleases.shift()?.();
    await waitForAdmissionPoll();
    const admittedTransaction = await pendingTransaction;
    expect(transaction).toHaveBeenCalledWith("write");

    for (const release of queryReleases) {
      release();
    }
    await Promise.all(reads);
    admittedTransaction.close();

    expect(transactionClose).toHaveBeenCalledTimes(1);
    expect(spanContexts.at(-1)).toMatchObject({
      attributes: {
        "fluncle.access_class": "write",
        "fluncle.operation_id": "db.write.transaction",
      },
      name: "db.query db.write.transaction",
      op: "db.query",
    });
    expect(spanAttributes.at(-1)).toMatchObject({
      "fluncle.aggregate_in_flight_max": 4,
      "fluncle.duration_ms": expect.any(Number),
      "fluncle.outcome": "success",
      "fluncle.queue_wait_ms": expect.any(Number),
    });
  });

  it("releases an internally closed failed transaction exactly once", async () => {
    let closed = false;
    const transactionClose = vi.fn(() => {
      closed = true;
    });
    const transactionCommit = vi.fn(async () => {
      closed = true;
      throw new Error("commit failed after driver cleanup");
    });
    transaction.mockResolvedValue({
      batch: vi.fn(),
      close: transactionClose,
      get closed() {
        return closed;
      },
      commit: transactionCommit,
      execute: vi.fn(),
      executeMultiple: vi.fn(),
      rollback: vi.fn(),
    });

    const releases: Array<() => void> = [];
    execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ rows: [] }));
        }),
    );

    const db = await getDb();
    const admittedTransaction = await db.transaction("write");
    const admittedReads = Array.from({ length: 3 }, () => db.execute("select 1"));
    const queuedRead = db.execute("select 2");
    for (let turn = 0; turn < 20 && execute.mock.calls.length < 3; turn += 1) {
      await Promise.resolve();
    }
    expect(execute).toHaveBeenCalledTimes(3);

    await expect(admittedTransaction.commit()).rejects.toThrow(
      "commit failed after driver cleanup",
    );
    for (let turn = 0; turn < 20 && execute.mock.calls.length < 4; turn += 1) {
      await waitForAdmissionPoll();
    }
    expect(execute).toHaveBeenCalledTimes(4);

    admittedTransaction.close();
    expect(transactionClose).toHaveBeenCalledTimes(1);
    expect(spanEnds[0]).toHaveBeenCalledTimes(1);
    expect(spanAttributes[0]).toMatchObject({ "fluncle.outcome": "failure" });

    for (const release of releases) {
      release();
    }
    await Promise.all([...admittedReads, queuedRead]);
  });

  it("forwards the two-arg execute(sql, args) form untouched", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    await db.execute("select ?", [7]);

    expect(execute).toHaveBeenCalledWith("select ?", [7]);
    expect(spanContexts[0]?.name).toMatch(/^db\.query db\.read\./);
  });

  it("names the span from the sql of the execute({ sql, args }) object form", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    await db.execute({ args: [2], sql: "select 2" });

    expect(execute).toHaveBeenCalledWith({ args: [2], sql: "select 2" });
    expect(spanContexts[0]?.name).toMatch(/^db\.query db\.read\./);
  });

  it("returns the batch result unchanged and names the span by statement count", async () => {
    const results = [{ rows: [] }, { rows: [] }];
    batch.mockResolvedValue(results);

    const db = await getDb();
    const returned = await db.batch([{ sql: "a" }, { sql: "b" }]);

    expect(returned).toBe(results);
    expect(batch).toHaveBeenCalledWith([{ sql: "a" }, { sql: "b" }], undefined);
    expect(spanContexts[0]).toMatchObject({
      attributes: {
        "db.batch.size": 2,
        "db.system": "sqlite",
        "fluncle.access_class": "write",
        "fluncle.attempt_count": 1,
        "fluncle.batch_count": 2,
        "fluncle.operation_id": expect.stringMatching(/^db\.write\.[a-z0-9]+$/),
      },
      name: expect.stringMatching(/^db\.query db\.write\.[a-z0-9]+$/),
      op: "db.query",
    });
    expect(spanAttributes[0]).toMatchObject({
      "fluncle.duration_ms": expect.any(Number),
      "fluncle.outcome": "success",
    });
    expect(JSON.stringify({ spanAttributes, spanContexts })).not.toContain('"sql"');
  });

  it("passes non-query methods straight through without a span", async () => {
    const db = await getDb();
    db.close();

    expect(close).toHaveBeenCalledTimes(1);
    expect(spanContexts).toHaveLength(0);
  });

  it("preserves the client's constructor for Drizzle's config detection", async () => {
    const db = await getDb();

    expect(db.constructor).toBe(Object);
  });

  it("never records SQL literals, arguments, URLs, or topology", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    const secret = "private-value";
    await db.execute(`select * from tracks where title = '${secret}' and source = ?`, [
      "https://private.invalid/path",
    ]);

    const recorded = JSON.stringify({ spanAttributes, spanContexts });
    expect(recorded).not.toContain(secret);
    expect(recorded).not.toContain("private.invalid");
    expect(recorded).not.toContain("select * from tracks");
    expect(spanContexts[0]?.attributes?.["db.statement"]).toMatch(
      /^SELECT \[db\.read\.[a-z0-9]+\]$/,
    );
  });

  it("uses a deterministic fallback for literal variants and unsafe explicit IDs", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    await db.execute("select * from tracks where id = 'synthetic-001'");
    await db.execute("select * from tracks where id = 'synthetic-999'");
    await db.execute(
      databaseOperationStatement("select 1", {
        accessClass: "heavy-read",
        operationId: `Unsafe private URL ${"x".repeat(100)}`,
      }),
    );

    const first = spanContexts[0]?.attributes?.["fluncle.operation_id"];
    const second = spanContexts[1]?.attributes?.["fluncle.operation_id"];
    const fallback = spanContexts[2]?.attributes?.["fluncle.operation_id"];
    expect(first).toBe(second);
    expect(fallback).toMatch(/^db\.heavy-read\.[a-z0-9]+$/);
    expect(String(fallback).length).toBeLessThanOrEqual(64);
  });

  it("keeps a valid explicit operation ID and may elevate a read to heavy-read", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    await db.execute(
      databaseOperationStatement(
        { args: [], sql: "select * from track_embeddings" },
        {
          accessClass: "heavy-read",
          operationId: "sonar.refresh",
        },
      ),
    );

    expect(spanContexts[0]).toMatchObject({
      attributes: {
        "fluncle.access_class": "heavy-read",
        "fluncle.operation_id": "sonar.refresh",
      },
      name: "db.query sonar.refresh",
    });
  });

  it("classifies a vector-distance scan as heavy-read without caller annotation", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    await db.execute(
      "select track_id from track_embeddings order by vector_distance_cos(embedding_blob, ?)",
    );

    expect(spanContexts[0]).toMatchObject({
      attributes: {
        "fluncle.access_class": "heavy-read",
        "fluncle.operation_id": expect.stringMatching(/^db\.heavy-read\.[a-z0-9]+$/),
      },
    });
  });

  it("records failures unchanged and releases every aggregate seat", async () => {
    const error = new Error("synthetic failure");
    execute.mockRejectedValue(error);

    const db = await getDb();
    const failures = await Promise.allSettled(
      Array.from({ length: 4 }, () => db.execute("update tracks set bpm = 1")),
    );

    expect(failures).toEqual(
      Array.from({ length: 4 }, () => ({ reason: error, status: "rejected" })),
    );
    execute.mockResolvedValue({ rows: [] });
    await expect(db.execute("select 1")).resolves.toEqual({ rows: [] });
    expect(execute).toHaveBeenCalledTimes(5);

    for (const attributes of spanAttributes.slice(0, 4)) {
      expect(attributes).toMatchObject({
        "fluncle.duration_ms": expect.any(Number),
        "fluncle.outcome": "failure",
      });
    }
  });
});

describe("getDb transient-gateway retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushBackoff() {
    await Promise.resolve();
    await vi.runAllTimersAsync();
  }

  const RESOLVED = Symbol("resolved");

  async function rejectionAfterTimers(pending: Promise<unknown>): Promise<unknown> {
    const outcome = pending.then(
      () => RESOLVED,
      (error: unknown) => error,
    );

    await flushBackoff();

    return outcome;
  }

  it("retries a select that fails once with a 502 and returns the retried result", async () => {
    const result = { rows: [{ id: 1 }] };
    execute.mockRejectedValueOnce(gatewayError(502)).mockResolvedValue(result);

    const db = await getDb();
    const pending = db.execute("select 1");
    await flushBackoff();

    await expect(pending).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retries a `with … select` CTE", async () => {
    const result = { rows: [] };
    execute.mockRejectedValueOnce(gatewayError(502)).mockResolvedValue(result);

    const db = await getDb();
    const pending = db.execute("with base as (select 1) select * from base");
    await flushBackoff();

    await expect(pending).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retries a statement behind leading whitespace and comments", async () => {
    const result = { rows: [] };
    execute.mockRejectedValueOnce(gatewayError(503)).mockResolvedValue(result);

    const db = await getDb();
    const pending = db.execute("  -- pinned\n /* note */ select 1");
    await flushBackoff();

    await expect(pending).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("records the retry count on the query's single span", async () => {
    execute.mockRejectedValueOnce(gatewayError(504)).mockResolvedValue({ rows: [] });

    const db = await getDb();
    const pending = db.execute("select 1");
    await flushBackoff();
    await pending;

    expect(spanContexts).toHaveLength(1);
    expect(spanAttributes[0]).toMatchObject({
      "db.retry.attempts": 1,
      "fluncle.attempt_count": 2,
      "fluncle.outcome": "success",
    });
  });

  it("retries a read that fails once with a 520 connection error", async () => {
    const result = { rows: [] };
    execute.mockRejectedValueOnce(gatewayError(520)).mockResolvedValue(result);

    const db = await getDb();
    const pending = db.execute("select 1");
    await flushBackoff();

    await expect(pending).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retries a read that fails once with a 522 connection error", async () => {
    const result = { rows: [] };
    execute.mockRejectedValueOnce(gatewayError(522)).mockResolvedValue(result);

    const db = await getDb();
    const pending = db.execute("select 1");
    await flushBackoff();

    await expect(pending).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retries a read that fails once with a 525 connection error", async () => {
    const result = { rows: [] };
    execute.mockRejectedValueOnce(gatewayError(525)).mockResolvedValue(result);

    const db = await getDb();
    const pending = db.execute("select 1");
    await flushBackoff();

    await expect(pending).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retries a read that fails once with a 530 unreachable-origin error", async () => {
    const result = { rows: [{ slug: "an-album" }] };
    execute.mockRejectedValueOnce(gatewayError(530)).mockResolvedValue(result);

    const db = await getDb();
    const pending = db.execute("select slug from albums where slug = ? limit 1");
    await flushBackoff();

    await expect(pending).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("leaves the retry attribute off a query that never retried", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    await db.execute("select 1");

    expect(spanAttributes[0]).toMatchObject({
      "fluncle.attempt_count": 1,
      "fluncle.outcome": "success",
    });
    expect(spanAttributes[0]).not.toHaveProperty("db.retry.attempts");
  });

  it("rethrows the original error once the retry cap is exhausted", async () => {
    const error = gatewayError(502);
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute("select 1"))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(DB_MAX_RETRIES + 1);
    expect(spanAttributes[0]).toMatchObject({
      "db.retry.attempts": DB_MAX_RETRIES,
      "fluncle.attempt_count": DB_MAX_RETRIES + 1,
      "fluncle.outcome": "failure",
    });
  });

  it.each([
    ["insert into tracks (id) values (1)"],
    ["update tracks set bpm = 1"],
    ["delete from tracks"],
    ["replace into tracks (id) values (1)"],
    ["pragma foreign_keys = on"],
    ["begin"],

    ["with doomed as (select id from tracks) delete from tracks"],
    ["with fresh as (select 1) update tracks set bpm = 1"],
    ["with rows as (select 1) insert into tracks (id) select 1 from rows"],
  ])("never retries a write: %s", async (sql) => {
    const error = gatewayError(502);
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute(sql))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["insert into tracks (id) values (1)"],
    ["update tracks set bpm = 1"],
    ["delete from tracks"],
    ["with doomed as (select id from tracks) delete from tracks"],
  ])("never retries a write on a 530 either: %s", async (sql) => {
    const error = gatewayError(530);
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute(sql))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never retries a batch outside read mode, which is one unit and may contain writes", async () => {
    const error = gatewayError(502);
    batch.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.batch([{ sql: "select 1" }]))).toBe(error);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(spanAttributes[0]).toMatchObject({
      "fluncle.duration_ms": expect.any(Number),
      "fluncle.outcome": "failure",
    });
  });

  it("retries a read-mode batch whose every statement is a confident read", async () => {
    const results = [{ rows: [] }, { rows: [] }];
    batch.mockRejectedValueOnce(gatewayError(503)).mockResolvedValue(results);

    const db = await getDb();
    const pending = db.batch([{ sql: "select 1" }, { sql: "select 2" }], "read");
    await flushBackoff();

    await expect(pending).resolves.toBe(results);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenLastCalledWith([{ sql: "select 1" }, { sql: "select 2" }], "read");
    expect(spanAttributes[0]).toMatchObject({ "db.retry.attempts": 1 });
  });

  it("never retries a read-mode batch carrying a statement it cannot vouch for as a read", async () => {
    const error = gatewayError(502);
    batch.mockRejectedValue(error);

    const db = await getDb();
    const statements = [{ sql: "select 1" }, { sql: "update tracks set bpm = 1" }];

    expect(await rejectionAfterTimers(db.batch(statements, "read"))).toBe(error);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it.each([[400], [401], [404], [429]])("does not retry a %i", async (status) => {
    const error = gatewayError(status);
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute("select 1"))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 524 gateway timeout", async () => {
    const error = gatewayError(524);
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute("select 1"))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries the did-not-complete class and never the may-have-executed one", async () => {
    execute.mockRejectedValue(gatewayError(524));

    const db = await getDb();

    await rejectionAfterTimers(db.execute("select 1"));
    expect(execute).toHaveBeenCalledTimes(1);

    const result = { rows: [] };
    execute.mockReset();
    execute.mockRejectedValueOnce(gatewayError(530)).mockResolvedValue(result);

    const pending = db.execute("select 1");
    await flushBackoff();

    await expect(pending).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error with no recognizable gateway status", async () => {
    const error = new Error("SQLITE_CONSTRAINT: unique constraint failed");
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute("select 1"))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
