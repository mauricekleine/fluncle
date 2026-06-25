import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ServiceStatusRow } from "./status";

// `getServiceStatuses` is the SHARED read every status surface goes through (the
// /status page, /api/status, the CLI `status` command, the MCP `get_status` tool).
// It must drop retired/orphaned service ids — chiefly the pre-split `automation`
// aggregate, which the healthcheck cron no longer posts but which lingers in
// `service_status` until an operator deletes the row — so a permanently-stale row
// never surfaces on any consumer. We mock the db so the read returns a fixed set.

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

const { getServiceStatuses } = await import("./status");

function row(service: string): ServiceStatusRow {
  return {
    checked_at: "2026-06-25T00:00:00.000Z",
    latency_ms: 42,
    message: null,
    service,
    since: "2026-06-25T00:00:00.000Z",
    status: "ok",
  };
}

describe("getServiceStatuses retired-row filter", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("drops the orphaned `automation` aggregate row", async () => {
    execute.mockResolvedValue({
      rows: [row("web"), row("automation"), row("cron.render"), row("render-box")],
    });

    const services = await getServiceStatuses();
    const ids = services.map((service) => service.service);

    expect(ids).not.toContain("automation");
    // Every CURRENT service still passes through, including both render probes.
    expect(ids).toEqual(["web", "cron.render", "render-box"]);
  });

  it("returns every row unchanged when no retired id is present", async () => {
    execute.mockResolvedValue({ rows: [row("web"), row("db"), row("hermes")] });

    const services = await getServiceStatuses();

    expect(services.map((service) => service.service)).toEqual(["web", "db", "hermes"]);
  });
});
