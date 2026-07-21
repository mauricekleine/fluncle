import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";
import { type StatusResponse, type StatusService } from "./status";

function service(
  name: string,
  status: StatusService["status"],
  message: string | null = null,
): StatusService {
  return {
    checkedAt: "2026-06-25T00:00:00.000Z",
    latencyMs: 12,
    message,
    service: name,
    since: "2026-06-25T00:00:00.000Z",
    status,
  };
}

function snapshot(
  services: StatusService[],
  secondsSinceFreshestReport: number | null,
): StatusResponse {
  return {
    freshestReportAt: "2026-06-25T00:00:00.000Z",
    generatedAt: "2026-06-25T00:05:00.000Z",
    secondsSinceFreshestReport,
    secondsSinceProberReport: secondsSinceFreshestReport,
    services,
  };
}

// Capture every public API path the command requests so the test can prove it
// reads the public, non-oRPC /api/v1/status resource (not an admin path).
let requestedPaths: string[] = [];

await mock.module("../api", () => ({
  ...realApi,
  publicApiGet: async (path: string) => {
    requestedPaths.push(path);

    return snapshot([service("web", "ok")], 30);
  },
}));

const { statusCommand, statusLines } = await import("./status");

describe("status command — the public status read", () => {
  beforeEach(() => {
    requestedPaths = [];
  });

  test("GETs the public /api/v1/status resource (no auth, no admin path)", async () => {
    const result = await statusCommand();

    expect(requestedPaths).toEqual(["/api/v1/status"]);
    expect(result.services[0]?.service).toBe("web");
  });
});

describe("statusLines — the terse board", () => {
  test("headlines all-up when every service is ok", () => {
    const lines = statusLines(snapshot([service("web", "ok"), service("db", "ok")], 30));

    expect(lines[0]).toBe("All services up. The Galaxy holds.");
    expect(lines.join("\n")).toContain("Last checked 30s ago.");
  });

  test("headlines the down count and marks the down row", () => {
    const lines = statusLines(
      snapshot([service("web", "ok"), service("r2", "down", "no answer")], 120),
    );

    expect(lines[0]).toBe("1 service down.");
    // The down row carries the x mark and the service's own message.
    const r2Row = lines.find((line) => line.includes("r2"));
    expect(r2Row).toContain("x");
    expect(r2Row).toContain("no answer");
    expect(lines.join("\n")).toContain("Last checked 2m ago.");
  });

  test("headlines degraded when nothing is down but something limps", () => {
    const lines = statusLines(snapshot([service("web", "ok"), service("ssh", "degraded")], 30));

    expect(lines[0]).toBe("1 service limping. The rest holds.");
  });

  test("falls back to the registry label when a service has no message", () => {
    // `dns` carries no message, so the row borrows the registry surface's own
    // plain-words description (the catalog stays the single source of the label).
    const lines = statusLines(snapshot([service("dns", "ok")], 30));
    const dnsRow = lines.find((line) => line.includes("dns"));

    expect(dnsRow).toContain("coordinate");
  });

  test("reports the empty store plainly", () => {
    const lines = statusLines(snapshot([], null));

    expect(lines).toEqual(["No service reports yet. The healthcheck hasn't called in."]);
  });
});
