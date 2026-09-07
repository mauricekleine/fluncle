import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The underlying libsql client is faked so the focus is the instrumenting Proxy
// getDb() wraps it in: it must be TRANSPARENT (return exactly what the client
// returns, for every call form) and open one `db.query` span per query.
const execute = vi.fn();
const batch = vi.fn();
const close = vi.fn();
const transaction = vi.fn();
const createClient = vi.fn(() => ({ batch, close, execute, transaction }));

// Capture each span context and run its callback straight through — this mirrors
// `@sentry/core`'s real `startSpan` passthrough when no client is active (the
// node-script / test / dev case), so the mock also proves transparency.
const spanContexts: Array<{
  attributes?: Record<string, unknown>;
  name: string;
  op?: string;
}> = [];

// Attributes set on the span DURING the callback (the retry counter), one
// record per span, index-aligned with `spanContexts`.
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
}));

const { DB_MAX_RETRIES, databaseOperationStatement, getDb } = await import("./db");
const { runWithDatabaseRequestScope } = await import("./database-request-scope");

// Shaped like a real `LibsqlError` from a gateway blip: `mapHranaError` hands
// the hrana `HttpServerError` (which carries the numeric `status`) through as
// the thrown error's `cause`.
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

// The safety contract: reads retry a transient gateway 5xx, writes NEVER do.
describe("getDb transient-gateway retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The backoff is a real timer created inside the request path, so the fake
  // clock has to be driven for a retry to land.
  async function flushBackoff() {
    await Promise.resolve();
    await vi.runAllTimersAsync();
  }

  // Runs a failing query to completion WHILE draining the fake clock, and hands
  // back what it threw. Draining matters even where no retry is expected: if a
  // regression ever made one of those statements retryable, its backoff timers
  // fire and the call-count assertion fails cleanly instead of the test hanging
  // on a timer nothing advances.
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

  // The regression test for the reported bug: the failing statement was a CTE,
  // so a classifier that only matched `select` would not have covered it.
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
    // SQLite allows a CTE in front of a write — the write verb is what counts.
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

  it("never retries batch, which is one unit and may contain writes", async () => {
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

  it.each([[400], [401], [404], [429]])("does not retry a %i", async (status) => {
    const error = gatewayError(status);
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute("select 1"))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // 524 means the gateway already timed out ON this query — re-running it just
  // doubles the load for a near-certain second timeout.
  it("does not retry a 524 gateway timeout", async () => {
    const error = gatewayError(524);
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute("select 1"))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error with no recognizable gateway status", async () => {
    const error = new Error("SQLITE_CONSTRAINT: unique constraint failed");
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute("select 1"))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
