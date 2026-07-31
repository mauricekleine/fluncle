import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

let gets: string[] = [];

const page = {
  available: true,
  missingRoster: [],
  nextCursor: "next-page",
  rollups: [
    {
      blindCount: 1,
      expectedIntervalMs: 3_600_000,
      failedCount: 1,
      lastOccurredAt: "2026-07-30T19:00:00.000Z",
      liarCount: 1,
      runCount: 2,
      unit: "fluncle-sentry-triage",
    },
  ],
  rows: [
    {
      checked: null,
      createdAt: "2026-07-30T19:00:00.100Z",
      endedAt: "2026-07-30T19:00:05.000Z",
      errors: 2,
      exitCode: 0,
      expectedIntervalMs: null,
      gateState: null,
      id: "fluncle-sentry-triage:2026-07-30T19:00:00.000Z",
      missingFields: ["checked", "produced", "queue_depth"],
      occurredAt: "2026-07-30T19:00:00.000Z",
      ok: false,
      produced: null,
      queueDepth: null,
      runDurationMs: 5000,
      selfAssertedOk: true,
      summaryRaw: '{"errors":2,"ok":true}',
      summaryStatus: "parsed" as const,
      unit: "fluncle-sentry-triage",
      unrecognisedFields: [],
      vendorCalls: null,
    },
  ],
  totalCount: 2,
};

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    gets.push(path);

    return page;
  },
}));

const { telemetryCommand, telemetryLines } = await import("./admin-telemetry");

beforeEach(() => {
  gets = [];
});

describe("telemetryCommand", () => {
  test("passes every evidence filter and the cursor to the operator GET", async () => {
    const evidenceResult = await telemetryCommand({
      blind: true,
      cursor: "cursor-value",
      liar: true,
      limit: 25,
      missingField: "queue_depth",
      ok: false,
      since: "24h",
      unit: "fluncle-sentry-triage",
      until: "2026-07-30T20:00:00.000Z",
    });
    const missingResult = await telemetryCommand({
      limit: 50,
      missing: true,
      since: "24h",
    });

    expect(evidenceResult).toBe(page);
    expect(missingResult).toBe(page);
    expect(gets).toEqual([
      "/api/v1/admin/telemetry/runs?limit=25&blind=true&cursor=cursor-value&liar=true&missingField=queue_depth&ok=false&since=24h&unit=fluncle-sentry-triage&until=2026-07-30T20%3A00%3A00.000Z",
      "/api/v1/admin/telemetry/runs?limit=50&missing=true&since=24h",
    ]);
  });
});

describe("telemetryLines", () => {
  test("prints factual rollups and rows, then the resume cursor", () => {
    const lines = telemetryLines(page);

    const rendered = lines.join("\n");

    expect(lines[0]).toBe("Unit rollups (all runs in the selected time/unit window)");
    expect(rendered).toContain("CADENCE");
    expect(rendered).toContain("1h");
    expect(rendered).toContain("OK=0");
    expect(rendered).toContain("LIAR");
    expect(rendered).toContain("BLIND");
    expect(rendered).toContain("Evidence rows (1 of 2 matching; this page)");
    expect(rendered).toContain("fluncle-sentry-triage");
    expect(lines.at(-1)).toBe("Next cursor: next-page");
  });

  test("renders the missing-roster view with expected cadence even without rows", () => {
    const lines = telemetryLines(
      {
        available: true,
        missingRoster: [
          {
            expectedIntervalMs: 300_000,
            unit: "fluncle-enrich",
          },
        ],
        nextCursor: null,
        rollups: [],
        rows: [],
        totalCount: 0,
      },
      { missing: true },
    );

    expect(lines).toEqual([
      "Expected writers with no run (1)",
      "MISSING UNIT    CADENCE",
      "fluncle-enrich  5m",
    ]);
  });

  test("distinguishes an unavailable ledger from an empty configured window", () => {
    expect(
      telemetryLines({
        available: false,
        missingRoster: [],
        nextCursor: null,
        rollups: [],
        rows: [],
        totalCount: 0,
      }),
    ).toEqual(["Telemetry database is not configured."]);
    expect(
      telemetryLines({
        available: true,
        missingRoster: [],
        nextCursor: null,
        rollups: [],
        rows: [],
        totalCount: 0,
      }),
    ).toEqual(["No run events matched."]);
    expect(
      telemetryLines(
        {
          available: true,
          missingRoster: [],
          nextCursor: null,
          rollups: [],
          rows: [],
          totalCount: 0,
        },
        { missing: true },
      ),
    ).toEqual(["No expected writers are missing."]);
  });
});
