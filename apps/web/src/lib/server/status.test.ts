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

  it("drops the retired `cron.artist-follow` row (the removed auto-follow cron)", async () => {
    execute.mockResolvedValue({
      rows: [row("cron.artist-sweep"), row("cron.artist-follow"), row("cron.enrich")],
    });

    const services = await getServiceStatuses();
    const ids = services.map((service) => service.service);

    expect(ids).not.toContain("cron.artist-follow");
    // The kept resolution cron (cron.artist-sweep) still passes through.
    expect(ids).toEqual(["cron.artist-sweep", "cron.enrich"]);
  });

  it("returns every row unchanged when no retired id is present", async () => {
    execute.mockResolvedValue({ rows: [row("web"), row("db"), row("hermes")] });

    const services = await getServiceStatuses();

    expect(services.map((service) => service.service)).toEqual(["web", "db", "hermes"]);
  });
});

// A cron that has NEVER run must not sit green forever. The box healthcheck emits
// "no runs yet" as `ok` on purpose (a freshly-rebuilt box has not ticked, and that is not a
// fault) — but the grace was UNBOUNDED, so `cron.clip-drip`, registered in the registry but
// never installed on rave-02, reported ok/"no runs yet" for days. A monitor that reassures
// you about a job that does not exist is worse than no monitor.
describe("getServiceStatuses — a cron stuck on 'no runs yet' stops being green", () => {
  const NOW = Date.parse("2026-07-11T00:00:00.000Z");

  function noRuns(service: string, since: string): ServiceStatusRow {
    return { ...row(service), message: "no runs yet", since, status: "ok" };
  }

  beforeEach(() => {
    execute.mockReset();
  });

  it("keeps a fresh no-runs-yet green (a box that just rebuilt has not ticked)", async () => {
    // 1h ago — well inside the grace window.
    execute.mockResolvedValue({ rows: [noRuns("cron.enrich", "2026-07-10T23:00:00.000Z")] });

    const [service] = await getServiceStatuses(NOW);

    expect(service?.status).toBe("ok");
    expect(service?.message).toBe("no runs yet");
  });

  it("degrades a no-runs-yet that has persisted past the grace window (never deployed)", async () => {
    // 4 days of "no runs yet" is not a fresh box — the cron was never installed.
    execute.mockResolvedValue({ rows: [noRuns("cron.clip-drip", "2026-07-07T00:00:00.000Z")] });

    const [service] = await getServiceStatuses(NOW);

    expect(service?.status).toBe("degraded");
    expect(service?.message).toMatch(/never run/i);
  });

  it("leaves a healthy running cron untouched", async () => {
    execute.mockResolvedValue({ rows: [{ ...row("cron.enrich"), message: "fresh" }] });

    const [service] = await getServiceStatuses(NOW);

    expect(service?.status).toBe("ok");
    expect(service?.message).toBe("fresh");
  });
});
