import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

let gets: string[] = [];

const page = {
  available: true,
  nextCursor: "next-page",
  rollups: [
    {
      blindCount: 1,
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
  test("passes every filter and the cursor to the operator GET", async () => {
    const result = await telemetryCommand({
      cursor: "cursor-value",
      limit: 25,
      ok: false,
      since: "2026-07-30T18:00:00.000Z",
      unit: "fluncle-sentry-triage",
      until: "2026-07-30T20:00:00.000Z",
    });

    expect(result).toBe(page);
    expect(gets).toEqual([
      "/api/v1/admin/telemetry/runs?limit=25&cursor=cursor-value&ok=false&since=2026-07-30T18%3A00%3A00.000Z&unit=fluncle-sentry-triage&until=2026-07-30T20%3A00%3A00.000Z",
    ]);
  });
});

describe("telemetryLines", () => {
  test("prints factual rollups and rows, then the resume cursor", () => {
    const lines = telemetryLines(page);

    expect(lines[0]).toBe("Unit rollups (2 matching runs)");
    expect(lines.join("\n")).toContain("OK=0");
    expect(lines.join("\n")).toContain("LIAR");
    expect(lines.join("\n")).toContain("BLIND");
    expect(lines.join("\n")).toContain("fluncle-sentry-triage");
    expect(lines.at(-1)).toBe("Next cursor: next-page");
  });

  test("distinguishes an unavailable ledger from an empty configured window", () => {
    expect(
      telemetryLines({
        available: false,
        nextCursor: null,
        rollups: [],
        rows: [],
        totalCount: 0,
      }),
    ).toEqual(["Telemetry database is not configured."]);
    expect(
      telemetryLines({
        available: true,
        nextCursor: null,
        rollups: [],
        rows: [],
        totalCount: 0,
      }),
    ).toEqual(["No run events matched."]);
  });
});
