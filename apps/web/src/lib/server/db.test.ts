import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The underlying libsql client is faked so the focus is the instrumenting Proxy
// getDb() wraps it in: it must be TRANSPARENT (return exactly what the client
// returns, for every call form) and open one `db.query` span per query.
const execute = vi.fn();
const batch = vi.fn();
const close = vi.fn();

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

vi.mock("@sentry/core", () => ({
  startSpan: (context: { name: string }, callback: (span: unknown) => unknown) => {
    spanContexts.push(context);

    const recorded: Record<string, unknown> = {};
    spanAttributes.push(recorded);

    return callback({
      setAttribute: (key: string, value: unknown) => {
        recorded[key] = value;
      },
    });
  },
}));

vi.mock("@libsql/client/web", () => ({ createClient: () => ({ batch, close, execute }) }));

vi.mock("./env", () => ({
  readEnvs: async () => ({ TURSO_AUTH_TOKEN: "token", TURSO_DATABASE_URL: "libsql://scratch" }),
}));

const { DB_MAX_RETRIES, getDb } = await import("./db");

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
  spanContexts.length = 0;
  spanAttributes.length = 0;
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
      attributes: { "db.statement": "select 1", "db.system": "sqlite" },
      name: "select 1",
      op: "db.query",
    });
  });

  it("forwards the two-arg execute(sql, args) form untouched", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    await db.execute("select ?", [7]);

    expect(execute).toHaveBeenCalledWith("select ?", [7]);
    expect(spanContexts[0]?.name).toBe("select ?");
  });

  it("names the span from the sql of the execute({ sql, args }) object form", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    await db.execute({ args: [2], sql: "select 2" });

    expect(execute).toHaveBeenCalledWith({ args: [2], sql: "select 2" });
    expect(spanContexts[0]?.name).toBe("select 2");
  });

  it("returns the batch result unchanged and names the span by statement count", async () => {
    const results = [{ rows: [] }, { rows: [] }];
    batch.mockResolvedValue(results);

    const db = await getDb();
    const returned = await db.batch([{ sql: "a" }, { sql: "b" }]);

    expect(returned).toBe(results);
    expect(batch).toHaveBeenCalledWith([{ sql: "a" }, { sql: "b" }], undefined);
    expect(spanContexts[0]).toMatchObject({
      attributes: { "db.batch.size": 2, "db.statement": "db.batch (2)", "db.system": "sqlite" },
      name: "db.batch (2)",
      op: "db.query",
    });
  });

  it("passes non-query methods straight through without a span", async () => {
    const db = await getDb();
    db.close();

    expect(close).toHaveBeenCalledTimes(1);
    expect(spanContexts).toHaveLength(0);
  });

  it("collapses whitespace and truncates an oversized span name", async () => {
    execute.mockResolvedValue({ rows: [] });

    const db = await getDb();
    const longSql = `select\n   ${"x".repeat(400)}`;
    await db.execute(longSql);

    const name = spanContexts[0]?.name ?? "";
    expect(name.length).toBe(200);
    expect(name.endsWith("…")).toBe(true);
    expect(name).not.toContain("\n");
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
    expect(spanAttributes[0]).toEqual({ "db.retry.attempts": 1 });
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

    expect(spanAttributes[0]).toEqual({});
  });

  it("rethrows the original error once the retry cap is exhausted", async () => {
    const error = gatewayError(502);
    execute.mockRejectedValue(error);

    const db = await getDb();

    expect(await rejectionAfterTimers(db.execute("select 1"))).toBe(error);
    expect(execute).toHaveBeenCalledTimes(DB_MAX_RETRIES + 1);
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
