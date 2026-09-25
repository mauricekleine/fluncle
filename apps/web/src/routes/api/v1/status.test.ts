import { beforeEach, describe, expect, it, vi } from "vitest";

const dbExecute = vi.fn();
const getServiceStatuses = vi.fn();
const getLiveState = vi.fn();

vi.mock("@/lib/server/db", () => ({ getDb: async () => ({ execute: dbExecute }) }));
vi.mock("@/lib/server/status", () => ({ getServiceStatuses: () => getServiceStatuses() }));
vi.mock("@/lib/server/live", () => ({ getLiveState: () => getLiveState() }));

const { serverHandlers } = await import("./status");

async function readJson(): Promise<Record<string, unknown>> {
  const response = await serverHandlers.GET();

  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  dbExecute.mockReset().mockResolvedValue({ rows: [{ 1: 1 }] });
  getServiceStatuses.mockReset().mockResolvedValue([]);
  getLiveState.mockReset().mockResolvedValue(null);
});

describe("/api/v1/status dbProbe", () => {
  it("reports the Worker→Turso round-trip on success", async () => {
    const body = await readJson();
    const probe = body["dbProbe"] as { at: string; roundTripMs: number } | null;

    expect(probe).not.toBeNull();
    expect(typeof probe?.roundTripMs).toBe("number");
    expect(probe?.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(typeof probe?.at).toBe("string");
    expect(dbExecute).toHaveBeenCalledWith("select 1");
  });

  it("returns dbProbe null (never throws) when the DB is unreachable", async () => {
    dbExecute.mockRejectedValue(new Error("network is unreachable"));

    const body = await readJson();

    expect(body["dbProbe"]).toBeNull();
    expect(body).toHaveProperty("services");
    expect(body).toHaveProperty("generatedAt");
  });
});

describe("/api/v1/status report freshness", () => {
  it("does not count a synthesized never-reported row as a fresh report", async () => {
    getServiceStatuses.mockResolvedValue([
      {
        checked_at: null,
        latency_ms: null,
        message: "never reported",
        service: "self-deploy-sonar",
        since: null,
        status: "degraded",
      },
      {
        checked_at: "2026-07-30T11:30:00.000Z",
        latency_ms: null,
        message: "last report is stale",
        service: "web",
        since: "2026-07-30T10:00:00.000Z",
        status: "degraded",
      },
    ]);

    const body = await readJson();

    expect(body["freshestReportAt"]).toBe("2026-07-30T11:30:00.000Z");
  });
});
