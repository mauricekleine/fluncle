import { describe, expect, it } from "vitest";
import {
  alertLevels,
  attributeDatabases,
  billingCycle,
  crossedAlertLevels,
  overageUsd,
  priceReading,
  TURSO_PRICE_TABLES,
  type TursoResourcePrice,
} from "./turso-pricing";

const SCALER = TURSO_PRICE_TABLES["scaler-2026-09"];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function price(key: keyof NonNullable<typeof SCALER>["resources"]): TursoResourcePrice {
  const resource = SCALER?.resources[key];

  if (!resource) {
    throw new Error(`missing ${key}`);
  }

  return resource;
}

describe("the Scaler price table", () => {
  it("charges nothing while a resource stays under its included quota", () => {
    expect(overageUsd(0, price("rowsWritten"))).toBe(0);
    expect(overageUsd(99_999_999, price("rowsWritten"))).toBe(0);
    expect(overageUsd(100e6, price("rowsWritten"))).toBe(0);
    expect(overageUsd(23e9, price("storage"))).toBe(0);
  });

  it("prices each resource past its quota at the published per-unit rate", () => {
    expect(overageUsd(182e6, price("rowsWritten"))).toBe(65.6);
    expect(overageUsd(353e9, price("embeddedSyncs"))).toBe(82.25);
    expect(overageUsd(101e9, price("rowsRead"))).toBe(0.8);
    expect(overageUsd(26e9, price("storage"))).toBe(1);
  });

  it("carries its source and base price", () => {
    expect(SCALER?.source).toBe("https://turso.tech/pricing");
    expect(SCALER?.baseMonthlyUsd).toBe(24.92);
  });
});

describe("the billing cycle", () => {
  it("runs from the first of the UTC month to the first of the next", () => {
    const cycle = billingCycle(Date.parse("2026-09-28T10:00:00Z"));

    expect(cycle.cycle).toBe("2026-09");
    expect(new Date(cycle.startMs).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(new Date(cycle.endMs).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(billingCycle(Date.parse("2026-12-31T23:59:59Z")).cycle).toBe("2026-12");
  });
});

describe("priceReading", () => {
  const cycle = billingCycle(Date.parse("2026-09-01T00:00:00Z"));
  const usage = {
    bytesSynced: 353e9,
    rowsRead: 50e9,
    rowsWritten: 182e6,
    storageBytes: 20e9,
  };

  it("reports zero overage and zero projection for an org under every quota", () => {
    const priced = priceReading({
      cycle,
      databases: [],
      observedAtMs: Date.parse("2026-09-10T00:00:00Z"),
      overagesEnabled: true,
      plan: "scaler",
      priors: [],
      usage: { bytesSynced: 1e9, rowsRead: 1e9, rowsWritten: 1e6, storageBytes: 1e9 },
    });

    expect(priced.overageUsd).toBe(0);
    expect(priced.projectedOverageUsd).toBe(0);
    expect(priced.projectedBillUsd).toBe(24.92);
    expect(priced.resources.every((resource) => resource.overageUsd === 0)).toBe(true);
  });

  it("projects cumulative resources to the reset from the recent daily run-rate", () => {
    const observedAtMs = Date.parse("2026-09-28T00:00:00Z");
    const priced = priceReading({
      cycle,
      databases: [],
      observedAtMs,
      overagesEnabled: true,
      plan: "scaler",
      priors: [
        {
          observedAtMs: observedAtMs - 2 * DAY_MS,
          usage: { ...usage, bytesSynced: 333e9, rowsWritten: 172e6 },
        },
        {
          observedAtMs: observedAtMs - 10 * DAY_MS,
          usage: { ...usage, bytesSynced: 100e9, rowsWritten: 100e6 },
        },
      ],
      usage,
    });
    const written = priced.resources.find((resource) => resource.key === "rowsWritten");
    const syncs = priced.resources.find((resource) => resource.key === "embeddedSyncs");
    const storage = priced.resources.find((resource) => resource.key === "storage");

    expect(priced.rateBasis).toBe("recent");
    expect(priced.rateWindowHours).toBe(48);
    expect(written?.dailyRate).toBeCloseTo(5e6);
    expect(written?.projectedUsed).toBeCloseTo(197e6);
    expect(written?.projectedOverageUsd).toBe(77.6);
    expect(syncs?.dailyRate).toBeCloseTo(10e9);
    expect(syncs?.projectedOverageUsd).toBe(89.75);
    expect(storage?.projectedUsed).toBe(20e9);
    expect(priced.overageUsd).toBe(147.85);
    expect(priced.projectedOverageUsd).toBe(167.35);
    expect(priced.projectedBillUsd).toBe(192.27);
  });

  it("falls back to the cycle-to-date average when no reading is old enough", () => {
    const observedAtMs = Date.parse("2026-09-11T00:00:00Z");
    const priced = priceReading({
      cycle,
      databases: [],
      observedAtMs,
      overagesEnabled: true,
      plan: "scaler",
      priors: [{ observedAtMs: observedAtMs - HOUR_MS, usage }],
      usage: { ...usage, rowsWritten: 100e6 },
    });
    const written = priced.resources.find((resource) => resource.key === "rowsWritten");

    expect(priced.rateBasis).toBe("cycle-to-date");
    expect(written?.dailyRate).toBeCloseTo(10e6);
    expect(written?.projectedUsed).toBeCloseTo(300e6);
    expect(written?.projectedOverageUsd).toBe(160);
  });

  it("ignores a prior reading from the previous cycle", () => {
    const observedAtMs = Date.parse("2026-09-01T00:30:00Z");
    const priced = priceReading({
      cycle,
      databases: [],
      observedAtMs,
      overagesEnabled: true,
      plan: "scaler",
      priors: [{ observedAtMs: observedAtMs - DAY_MS, usage }],
      usage: { ...usage, rowsWritten: 1e6 },
    });

    expect(priced.rateBasis).toBe("none");
    expect(priced.projectedOverageUsd).toBe(priced.overageUsd);
  });

  it("charges nothing when overages are off, since Turso blocks instead of billing", () => {
    const priced = priceReading({
      cycle,
      databases: [],
      observedAtMs: Date.parse("2026-09-28T00:00:00Z"),
      overagesEnabled: false,
      plan: "scaler",
      priors: [],
      usage,
    });

    expect(priced.overageUsd).toBe(0);
    expect(priced.projectedOverageUsd).toBe(0);
  });

  it("marks an unknown plan unpriced rather than guessing its rates", () => {
    const priced = priceReading({
      cycle,
      databases: [],
      observedAtMs: Date.parse("2026-09-28T00:00:00Z"),
      overagesEnabled: true,
      plan: "enterprise",
      priors: [],
      usage,
    });

    expect(priced.priced).toBe(false);
    expect(priced.priceTableVersion).toBe("unpriced");
    expect(priced.overageUsd).toBe(0);
  });
});

describe("attributeDatabases", () => {
  it("splits each resource's overage by the database's share of that resource", () => {
    const usage = { bytesSynced: 100, rowsRead: 0, rowsWritten: 200, storageBytes: 0 };
    const resources = [
      {
        dailyRate: 0,
        included: 0,
        key: "rowsWritten" as const,
        overageUsd: 10,
        projectedOverageUsd: 10,
        projectedUsed: 200,
        unitSize: 1,
        usdPerUnit: 1,
        used: 200,
      },
      {
        dailyRate: 0,
        included: 0,
        key: "embeddedSyncs" as const,
        overageUsd: 4,
        projectedOverageUsd: 4,
        projectedUsed: 100,
        unitSize: 1,
        usdPerUnit: 1,
        used: 100,
      },
    ];
    const attributed = attributeDatabases(
      [
        { bytesSynced: 0, name: "primary", rowsRead: 0, rowsWritten: 150, storageBytes: 0 },
        { bytesSynced: 100, name: "replica", rowsRead: 0, rowsWritten: 50, storageBytes: 0 },
      ],
      usage,
      resources,
    );

    expect(attributed.map((database) => [database.name, database.attributedOverageUsd])).toEqual([
      ["primary", 7.5],
      ["replica", 6.5],
    ]);
  });
});

describe("alert levels", () => {
  it("raises at the threshold and again at twice it", () => {
    expect(alertLevels(50)).toEqual([50, 100]);
    expect(crossedAlertLevels(50, 49.99)).toEqual([]);
    expect(crossedAlertLevels(50, 50)).toEqual([50]);
    expect(crossedAlertLevels(50, 167.35)).toEqual([50, 100]);
  });
});
