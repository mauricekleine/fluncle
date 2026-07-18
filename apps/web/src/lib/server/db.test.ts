import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@sentry/core", () => ({
  startSpan: (context: { name: string }, callback: (span: unknown) => unknown) => {
    spanContexts.push(context);

    return callback({});
  },
}));

vi.mock("@libsql/client/web", () => ({ createClient: () => ({ batch, close, execute }) }));

vi.mock("./env", () => ({
  readEnvs: async () => ({ TURSO_AUTH_TOKEN: "token", TURSO_DATABASE_URL: "libsql://scratch" }),
}));

const { getDb } = await import("./db");

beforeEach(() => {
  execute.mockReset();
  batch.mockReset();
  close.mockReset();
  spanContexts.length = 0;
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
