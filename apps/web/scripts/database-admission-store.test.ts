import { describe, expect, it } from "vitest";
import {
  DATABASE_ADMISSION_STORE_EPOCH_KEY,
  DATABASE_ADMISSION_STORE_KEY,
} from "../src/lib/server/database-admission";
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
    maxEpoch: 0,
    primaryLive: 0,
    rawEpochMarker: null,
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
    expect(planStoreChange("cutover", snapshot())).toEqual({
      epoch: 1,
      kind: "set",
      value: "telemetry:1",
    });
    expect(
      planStoreChange(
        "cutover",
        snapshot({ control: { epoch: 4, open: false }, route: { epoch: 2, store: "primary" } }),
      ),
    ).toEqual({ epoch: 5, kind: "set", value: "telemetry:5" });
    expect(
      planStoreChange(
        "rollback",
        snapshot({ control: { epoch: 5, open: true }, route: { epoch: 5, store: "telemetry" } }),
      ),
    ).toEqual({ epoch: 6, kind: "set", value: "primary:6" });
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
    ).toEqual({ epoch: null, kind: "set", value: "primary" });
    expect(planStoreChange("finalize", snapshot()).kind).toBe("refuse");
  });
});

describe("the admission store route write", () => {
  type Db = Awaited<ReturnType<typeof createIntegrationDb>>;

  async function read(db: Db, key: string) {
    const result = await db.execute({
      args: [key],
      sql: `select value from settings where key = ?`,
    });
    return result.rows[0]?.value ?? null;
  }

  it("plans past the highest epoch ever recorded", () => {
    expect(planStoreChange("cutover", snapshot({ maxEpoch: 4, rawEpochMarker: "4" }))).toEqual({
      epoch: 5,
      kind: "set",
      value: "telemetry:5",
    });
  });

  it("refuses a delayed finalize after a concurrent cutover changed the route", async () => {
    const db = await createIntegrationDb();
    expect(
      await compareAndSetStoreRoute(db, { epochMarker: null, route: null }, "telemetry:1", 1),
    ).toBe(true);
    expect(
      await compareAndSetStoreRoute(db, { epochMarker: "1", route: "telemetry:1" }, "primary:2", 2),
    ).toBe(true);
    expect(
      await compareAndSetStoreRoute(db, { epochMarker: "2", route: "primary:2" }, "telemetry:3", 3),
    ).toBe(true);

    expect(
      await compareAndSetStoreRoute(db, { epochMarker: "2", route: "primary:2" }, "primary", null),
    ).toBe(false);
    expect(await read(db, DATABASE_ADMISSION_STORE_KEY)).toBe("telemetry:3");
  });

  it("refuses a delayed cutover whose route value came back around (ABA)", async () => {
    const db = await createIntegrationDb();
    await db.batch(
      [
        {
          args: [DATABASE_ADMISSION_STORE_KEY, "primary"],
          sql: `insert into settings (key, value) values (?, ?)`,
        },
        {
          args: [DATABASE_ADMISSION_STORE_EPOCH_KEY, "2"],
          sql: `insert into settings (key, value) values (?, ?)`,
        },
      ],
      "write",
    );
    const delayed = { epochMarker: "2", route: "primary" };

    expect(await compareAndSetStoreRoute(db, delayed, "telemetry:3", 3)).toBe(true);
    expect(
      await compareAndSetStoreRoute(db, { epochMarker: "3", route: "telemetry:3" }, "primary:4", 4),
    ).toBe(true);
    expect(
      await compareAndSetStoreRoute(db, { epochMarker: "4", route: "primary:4" }, "primary", null),
    ).toBe(true);
    expect(await read(db, DATABASE_ADMISSION_STORE_KEY)).toBe("primary");

    expect(await compareAndSetStoreRoute(db, delayed, "telemetry:3", 3)).toBe(false);
    expect(await read(db, DATABASE_ADMISSION_STORE_KEY)).toBe("primary");
    expect(await read(db, DATABASE_ADMISSION_STORE_EPOCH_KEY)).toBe("4");
  });
});
