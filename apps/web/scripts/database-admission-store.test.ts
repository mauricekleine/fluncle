import { describe, expect, it } from "vitest";
import { DATABASE_ADMISSION_STORE_KEY } from "../src/lib/server/database-admission";
import { createIntegrationDb } from "../src/lib/server/integration-db";
import {
  compareAndSetStoreRoute,
  parseStoreCommand,
  planStoreChange,
  type StoreSnapshot,
} from "./database-admission-store";

function snapshot(overrides: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return {
    control: null,
    enforced: true,
    primaryLive: 0,
    rawRoute: null,
    route: { epoch: null, store: "primary" },
    telemetryLive: 0,
    ...overrides,
  };
}

describe("the admission store switch", () => {
  it("reads one command and defaults to a read-only status", () => {
    expect(parseStoreCommand([])).toBe("status");
    expect(parseStoreCommand(["cutover"])).toBe("cutover");
    expect(() => parseStoreCommand(["flip"])).toThrow(/unknown command/);
    expect(() => parseStoreCommand(["cutover", "now"])).toThrow(/exactly one command/);
  });

  it("stamps every route change with an epoch above both stores' last epoch", () => {
    expect(planStoreChange("cutover", snapshot())).toEqual({ kind: "set", value: "telemetry:1" });
    expect(
      planStoreChange(
        "cutover",
        snapshot({ control: { epoch: 4, open: false }, route: { epoch: 2, store: "primary" } }),
      ),
    ).toEqual({ kind: "set", value: "telemetry:5" });
    expect(
      planStoreChange(
        "rollback",
        snapshot({ control: { epoch: 5, open: true }, route: { epoch: 5, store: "telemetry" } }),
      ),
    ).toEqual({ kind: "set", value: "primary:6" });
  });

  it("refuses a no-op switch and an unrecognized stored route", () => {
    expect(
      planStoreChange("cutover", snapshot({ route: { epoch: 1, store: "telemetry" } })).kind,
    ).toBe("refuse");
    expect(planStoreChange("rollback", snapshot()).kind).toBe("refuse");
    expect(planStoreChange("cutover", snapshot({ rawRoute: "telemetry", route: null }))).toEqual({
      kind: "refuse",
      reason: "the stored route telemetry is not recognized; repair it first",
    });
  });

  it("finalizes a rollback only once telemetry is closed at that epoch and drained", () => {
    const rolledBack = { route: { epoch: 6, store: "primary" as const } };
    expect(
      planStoreChange("finalize", snapshot({ ...rolledBack, control: { epoch: 5, open: true } }))
        .kind,
    ).toBe("refuse");
    expect(
      planStoreChange(
        "finalize",
        snapshot({ ...rolledBack, control: { epoch: 6, open: false }, telemetryLive: 1 }),
      ).kind,
    ).toBe("refuse");
    expect(
      planStoreChange("finalize", snapshot({ ...rolledBack, control: { epoch: 6, open: false } })),
    ).toEqual({ kind: "set", value: "primary" });
    expect(planStoreChange("finalize", snapshot()).kind).toBe("refuse");
  });
});

describe("the admission store route write", () => {
  async function route(db: Awaited<ReturnType<typeof createIntegrationDb>>) {
    const result = await db.execute({
      args: [DATABASE_ADMISSION_STORE_KEY],
      sql: `select value from settings where key = ?`,
    });
    return result.rows[0]?.value ?? null;
  }

  it("refuses a delayed finalize after a concurrent cutover changed the route", async () => {
    const db = await createIntegrationDb();
    await db.execute({
      args: [DATABASE_ADMISSION_STORE_KEY, "primary:2"],
      sql: `insert into settings (key, value) values (?, ?)`,
    });
    await db.execute({
      args: ["telemetry:3", DATABASE_ADMISSION_STORE_KEY],
      sql: `update settings set value = ? where key = ?`,
    });

    expect(await compareAndSetStoreRoute(db, "primary:2", "primary")).toBe(false);
    expect(await route(db)).toBe("telemetry:3");
  });

  it("writes only over the exact prior route, including an absent one", async () => {
    const db = await createIntegrationDb();
    expect(await compareAndSetStoreRoute(db, null, "telemetry:1")).toBe(true);
    expect(await route(db)).toBe("telemetry:1");
    expect(await compareAndSetStoreRoute(db, null, "telemetry:2")).toBe(false);
    expect(await compareAndSetStoreRoute(db, "telemetry:1", "primary:2")).toBe(true);
    expect(await route(db)).toBe("primary:2");
  });
});
