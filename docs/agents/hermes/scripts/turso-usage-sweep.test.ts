import { describe, expect, test } from "bun:test";
import databases from "./fixtures/turso-usage/databases.json";
import invoices from "./fixtures/turso-usage/invoices-upcoming.json";
import organizationUsage from "./fixtures/turso-usage/organization-usage.json";
import subscription from "./fixtures/turso-usage/subscription.json";
import {
  type AcknowledgeResponse,
  buildPayload,
  discordMessage,
  missingCredentials,
  missingCredentialsSummary,
  parseDatabaseNames,
  parseOrganizationUsage,
  parseSubscription,
  parseUpcomingInvoiceUsd,
  type RecordPayload,
  type RecordResponse,
  runTursoUsageSweep,
  type SweepDeps,
} from "./turso-usage-sweep";

const FIXTURES: Record<string, unknown> = {
  "/databases": databases,
  "/invoices?type=upcoming": invoices,
  "/subscription": subscription,
  "/usage": organizationUsage,
};

const PENDING = [
  {
    cycle: "2026-09",
    deliveredAt: null,
    levelUsd: 50,
    projectedOverageUsd: 167.35,
    raisedAt: "2026-09-28T00:00:00.000Z",
  },
  {
    cycle: "2026-09",
    deliveredAt: null,
    levelUsd: 100,
    projectedOverageUsd: 167.35,
    raisedAt: "2026-09-28T00:00:00.000Z",
  },
];

function recorded(over: Partial<RecordResponse> = {}): RecordResponse {
  return {
    ok: true,
    pendingAlerts: [],
    snapshot: {
      cycle: "2026-09",
      cycleEnd: "2026-10-01T00:00:00.000Z",
      overageUsd: 147.85,
      projectedOverageUsd: 167.35,
      rateBasis: "recent",
      resources: [
        { key: "rowsWritten", overageUsd: 65.6, projectedOverageUsd: 77.6 },
        { key: "embeddedSyncs", overageUsd: 82.25, projectedOverageUsd: 89.75 },
        { key: "rowsRead", overageUsd: 0, projectedOverageUsd: 0 },
      ],
    },
    stored: true,
    thresholdUsd: 50,
    ...over,
  };
}

function deps(overrides: Partial<SweepDeps> = {}) {
  const calls = {
    acknowledged: [] as { cycle: string; levelUsd: number }[][],
    notified: [] as string[],
    recorded: [] as RecordPayload[],
  };
  const base: SweepDeps = {
    acknowledge: (alerts) => {
      calls.acknowledged.push(alerts);

      return Promise.resolve<AcknowledgeResponse>({ acknowledged: alerts.length, ok: true });
    },
    fetchTurso: (path) => {
      const body = FIXTURES[path];

      return body === undefined
        ? Promise.reject(new Error(`unexpected ${path}`))
        : Promise.resolve(body);
    },
    notify: (message) => {
      calls.notified.push(message);

      return Promise.resolve(true);
    },
    now: () => new Date("2026-09-28T00:00:00.000Z"),
    record: (payload) => {
      calls.recorded.push(payload);

      return Promise.resolve(recorded());
    },
  };

  return { calls, deps: { ...base, ...overrides } };
}

describe("parsing the recorded Turso platform responses", () => {
  test("reads the organization totals and each database's cycle total", () => {
    const usage = parseOrganizationUsage(organizationUsage);

    expect(usage.totals).toEqual({
      bytesSynced: 353_123_456_789,
      rowsRead: 61_234_567_890,
      rowsWritten: 182_345_678,
      storageBytes: 21_456_789_012,
    });
    expect(usage.databases).toHaveLength(3);
    expect(usage.databases[0]).toEqual({
      bytesSynced: 353_000_000_000,
      rowsRead: 60_000_000_000,
      rowsWritten: 170_000_000,
      storageBytes: 20_000_000_000,
      uuid: "392d53be-f751-4c16-a1a5-49dd57fe99df",
    });
  });

  test("an omitted counter reads as zero, since the API drops empty fields", () => {
    const usage = parseOrganizationUsage(organizationUsage);

    expect(usage.databases[2]).toEqual({
      bytesSynced: 0,
      rowsRead: 0,
      rowsWritten: 0,
      storageBytes: 4096,
      uuid: "7c1e0f4a-0000-4000-8000-000000000003",
    });
  });

  test("a response without organization usage is refused, never read as zero", () => {
    expect(() => parseOrganizationUsage({ error: "unauthorized" })).toThrow(/organization.usage/);
  });

  test("maps database ids to names", () => {
    expect([...parseDatabaseNames(databases).entries()]).toEqual([
      ["392d53be-f751-4c16-a1a5-49dd57fe99df", "app-primary"],
      ["0eb771dd-6906-11ee-8553-eaa7715aeaf2", "app-telemetry"],
    ]);
  });

  test("reads the plan and whether overages bill", () => {
    expect(parseSubscription(subscription)).toEqual({ name: "scaler", overages: true });
    expect(() => parseSubscription({ subscription: {} })).toThrow(/no plan/);
  });

  test("reads the upcoming invoice's amount due as dollars", () => {
    expect(parseUpcomingInvoiceUsd(invoices)).toBe(171.44);
    expect(parseUpcomingInvoiceUsd({ invoices: [] })).toBeNull();
    expect(parseUpcomingInvoiceUsd({})).toBeNull();
  });

  test("names a database the list no longer carries instead of dropping its usage", () => {
    const payload = buildPayload({
      names: parseDatabaseNames(databases),
      observedAt: new Date("2026-09-28T00:00:00.000Z"),
      subscription: parseSubscription(subscription),
      upcomingInvoiceUsd: null,
      usage: parseOrganizationUsage(organizationUsage),
    });

    expect(payload.databases.map((database) => database.name)).toEqual([
      "app-primary",
      "app-telemetry",
      "unlisted 7c1e0f4a",
    ]);
  });
});

describe("runTursoUsageSweep", () => {
  test("posts one priced reading and stays quiet with no pending alert", async () => {
    const { calls, deps: sweepDeps } = deps();
    const summary = await runTursoUsageSweep(sweepDeps);

    expect(summary).toMatchObject({
      checked: 1,
      cycle: "2026-09",
      databases: 3,
      errors: 0,
      notified: null,
      ok: true,
      overageUsd: 147.85,
      pendingAlerts: 0,
      produced: 1,
      projectedOverageUsd: 167.35,
      upcomingInvoiceUsd: 171.44,
    });
    expect(calls.recorded).toHaveLength(1);
    expect(calls.recorded[0]?.observedAt).toBe("2026-09-28T00:00:00.000Z");
    expect(calls.recorded[0]?.plan).toEqual({ name: "scaler", overages: true });
    expect(calls.notified).toEqual([]);
  });

  test("posts one Discord message for the pending levels, then acknowledges them", async () => {
    const { calls, deps: sweepDeps } = deps({
      record: () => Promise.resolve(recorded({ pendingAlerts: PENDING })),
    });
    const summary = await runTursoUsageSweep(sweepDeps);

    expect(calls.notified).toHaveLength(1);
    expect(calls.notified[0]).toContain("$167.35 by 2026-10-01");
    expect(calls.notified[0]).toContain("past the $100.00 alert line");
    expect(calls.notified[0]).toContain("embedded syncs $89.75, rows written $77.60");
    expect(calls.acknowledged).toEqual([
      [
        { cycle: "2026-09", levelUsd: 50 },
        { cycle: "2026-09", levelUsd: 100 },
      ],
    ]);
    expect(summary).toMatchObject({ alertAcknowledged: true, notified: true, pendingAlerts: 2 });
  });

  test("a failed Discord post leaves the alert unacknowledged for the next run", async () => {
    const { calls, deps: sweepDeps } = deps({
      notify: () => Promise.resolve(false),
      record: () => Promise.resolve(recorded({ pendingAlerts: PENDING })),
    });
    const summary = await runTursoUsageSweep(sweepDeps);

    expect(calls.acknowledged).toEqual([]);
    expect(summary).toMatchObject({ alertAcknowledged: false, notified: false, ok: true });
  });

  test("a failed acknowledgement is reported, not thrown", async () => {
    const { deps: sweepDeps } = deps({
      acknowledge: () => Promise.reject(new Error("boom")),
      record: () => Promise.resolve(recorded({ pendingAlerts: PENDING })),
    });
    const summary = await runTursoUsageSweep(sweepDeps);

    expect(summary).toMatchObject({ alertAcknowledged: false, notified: true, ok: true });
  });

  test("records without the invoice when the invoice read fails", async () => {
    const { calls, deps: sweepDeps } = deps({
      fetchTurso: (path) =>
        path.startsWith("/invoices")
          ? Promise.reject(new Error("403"))
          : Promise.resolve(FIXTURES[path]),
    });
    const summary = await runTursoUsageSweep(sweepDeps);

    expect(summary.ok).toBe(true);
    expect(calls.recorded[0]?.upcomingInvoiceUsd).toBeNull();
  });

  test("a usage read failure fails the run before anything is recorded", async () => {
    const { calls, deps: sweepDeps } = deps({
      fetchTurso: (path) =>
        path === "/usage" ? Promise.reject(new Error("401")) : Promise.resolve(FIXTURES[path]),
    });

    const failure = await runTursoUsageSweep(sweepDeps).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failure).toBe("401");
    expect(calls.recorded).toEqual([]);
  });

  test("an unstored reading fails the run loudly", async () => {
    const { deps: sweepDeps } = deps({
      record: () => Promise.resolve(recorded({ stored: false })),
    });
    const summary = await runTursoUsageSweep(sweepDeps);

    expect(summary).toMatchObject({ ok: false, produced: 0, reason: "telemetry_unprovisioned" });
  });

  test("a missing credential is an explicit failure naming what is absent", () => {
    const missing = missingCredentials({
      FLUNCLE_API_TOKEN: "set",
      TURSO_PLATFORM_API_TOKEN: "",
      TURSO_PLATFORM_ORG: "",
    });

    expect(missing).toEqual(["TURSO_PLATFORM_API_TOKEN", "TURSO_PLATFORM_ORG"]);
    expect(missingCredentialsSummary(missing)).toMatchObject({
      checked: null,
      errors: 1,
      ok: false,
      reason: "missing_credentials",
    });
  });
});

describe("discordMessage", () => {
  test("names the projection, the line crossed, and the board", () => {
    const message = discordMessage(recorded(), PENDING.slice(0, 1));

    expect(message).toContain("past the $50.00 alert line");
    expect(message).toContain("So far this cycle: $147.85.");
    expect(message).toContain("/admin/costs");
  });
});
