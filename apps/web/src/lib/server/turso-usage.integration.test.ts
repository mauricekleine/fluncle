import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTelemetryIntegrationDb } from "./telemetry-integration-db";
import {
  acknowledgeTursoUsageAlerts,
  getTursoUsageBoard,
  parseThreshold,
  recordTursoUsage,
  type RecordTursoUsageInput,
  TURSO_USAGE_THRESHOLD_KEY,
} from "./turso-usage";

let telemetryDb: Client | undefined;
const settings = new Map<string, string>();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getTelemetryDb: () => Promise.resolve(telemetryDb) };
});

vi.mock("./settings", () => ({
  getSetting: (key: string) => Promise.resolve(settings.get(key)),
  setSetting: (key: string, value: string) => {
    settings.set(key, value);

    return Promise.resolve();
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;

function reading(
  observedAt: string,
  over: Partial<RecordTursoUsageInput["usage"]> = {},
): RecordTursoUsageInput {
  return {
    databases: [
      {
        bytesSynced: 300e9,
        name: "primary",
        rowsRead: 40e9,
        rowsWritten: 150e6,
        storageBytes: 18e9,
      },
      { bytesSynced: 0, name: "telemetry", rowsRead: 1e9, rowsWritten: 2e6, storageBytes: 1e9 },
    ],
    observedAt,
    plan: { name: "scaler", overages: true, timeline: "yearly" },
    upcomingInvoiceUsd: 120.5,
    usage: {
      bytesSynced: 300e9,
      rowsRead: 41e9,
      rowsWritten: 152e6,
      storageBytes: 19e9,
      ...over,
    },
  };
}

describe("recordTursoUsage", () => {
  beforeEach(async () => {
    telemetryDb = await createTelemetryIntegrationDb();
    settings.clear();
  });

  it("stores a priced snapshot and reads it back on the board with a per-day history", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");

    await recordTursoUsage(reading("2026-09-18T12:00:00Z", { rowsWritten: 140e6 }), now);
    await recordTursoUsage(reading("2026-09-19T06:00:00Z", { rowsWritten: 144e6 }), now);
    await recordTursoUsage(reading("2026-09-19T12:00:00Z", { rowsWritten: 146e6 }), now);
    const result = await recordTursoUsage(reading("2026-09-20T12:00:00Z"), now);

    expect(result.stored).toBe(true);
    expect(result.snapshot.rateBasis).toBe("recent");
    expect(result.snapshot.overageUsd).toBe(110.6);
    expect(result.snapshot.databases[0]?.name).toBe("primary");

    const board = await getTursoUsageBoard(now);

    expect(board.available).toBe(true);
    expect(board.latest?.observedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(board.latest?.upcomingInvoiceUsd).toBe(120.5);
    expect(board.history.map((day) => [day.day, day.rowsWritten])).toEqual([
      ["2026-09-18", 140e6],
      ["2026-09-19", 146e6],
      ["2026-09-20", 152e6],
    ]);
    expect(board.thresholdUsd).toBe(50);
  });

  it("re-recording the same reading overwrites it instead of doubling the history", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");

    await recordTursoUsage(reading("2026-09-20T12:00:00Z"), now);
    await recordTursoUsage(reading("2026-09-20T12:00:00Z"), now);

    const count = await telemetryDb?.execute("select count(*) as n from turso_usage_snapshots");

    expect(Number(count?.rows[0]?.n)).toBe(1);
  });

  it("raises each threshold once per cycle and keeps it pending until acknowledged", async () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    const first = await recordTursoUsage(reading("2026-09-28T00:00:00Z"), now);

    expect(first.snapshot.projectedOverageUsd).toBeGreaterThanOrEqual(100);
    expect(first.pendingAlerts.map((alert) => alert.levelUsd)).toEqual([50, 100]);

    const retried = await recordTursoUsage(reading("2026-09-28T06:00:00Z"), now);

    expect(retried.pendingAlerts.map((alert) => alert.levelUsd)).toEqual([50, 100]);
    expect(retried.pendingAlerts[0]?.raisedAt).toBe(first.pendingAlerts[0]?.raisedAt);

    const acknowledged = await acknowledgeTursoUsageAlerts(
      retried.pendingAlerts.map((alert) => ({ cycle: alert.cycle, levelUsd: alert.levelUsd })),
      now,
    );

    expect(acknowledged).toBe(2);

    const after = await recordTursoUsage(reading("2026-09-28T12:00:00Z"), now);

    expect(after.pendingAlerts).toEqual([]);
    expect(await acknowledgeTursoUsageAlerts([{ cycle: "2026-09", levelUsd: 50 }], now)).toBe(0);

    const board = await getTursoUsageBoard(now);

    expect(board.alerts.map((alert) => alert.deliveredAt !== null)).toEqual([true, true]);
  });

  it("raises again in the next cycle", async () => {
    const september = await recordTursoUsage(
      reading("2026-09-28T00:00:00Z"),
      Date.parse("2026-09-28T00:00:00Z"),
    );

    await acknowledgeTursoUsageAlerts(
      september.pendingAlerts.map((alert) => ({ cycle: alert.cycle, levelUsd: alert.levelUsd })),
    );

    const october = await recordTursoUsage(
      reading("2026-10-02T00:00:00Z"),
      Date.parse("2026-10-02T00:00:00Z") + DAY_MS,
    );

    expect(october.snapshot.cycle).toBe("2026-10");
    expect(october.pendingAlerts.map((alert) => alert.cycle)).toEqual(["2026-10", "2026-10"]);
  });

  it("stays quiet under the operator's threshold", async () => {
    settings.set(TURSO_USAGE_THRESHOLD_KEY, "1000");

    const result = await recordTursoUsage(
      reading("2026-09-28T00:00:00Z"),
      Date.parse("2026-09-28T00:00:00Z"),
    );

    expect(result.thresholdUsd).toBe(1000);
    expect(result.pendingAlerts).toEqual([]);
  });

  it("refuses a reading stamped in the future", async () => {
    await expect(
      recordTursoUsage(reading("2026-09-29T00:00:00Z"), Date.parse("2026-09-28T00:00:00Z")),
    ).rejects.toThrow(/future/);
  });

  it("reports an unprovisioned telemetry database as not stored", async () => {
    telemetryDb = undefined;

    const result = await recordTursoUsage(
      reading("2026-09-28T00:00:00Z"),
      Date.parse("2026-09-28T00:00:00Z"),
    );

    expect(result.stored).toBe(false);
    expect((await getTursoUsageBoard()).available).toBe(false);
  });
});

describe("parseThreshold", () => {
  it("falls back to the default for a missing or nonsense value", () => {
    expect(parseThreshold(undefined)).toBe(50);
    expect(parseThreshold("abc")).toBe(50);
    expect(parseThreshold("-5")).toBe(50);
    expect(parseThreshold("75.5")).toBe(75.5);
  });
});
