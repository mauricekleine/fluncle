import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ServiceStatusRow } from "./status";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

const { getServiceStatuses } = await import("./status");

function row(service: string, overrides: Partial<ServiceStatusRow> = {}): ServiceStatusRow {
  return {
    checked_at: "2026-06-25T00:00:00.000Z",
    latency_ms: 42,
    message: null,
    service,
    since: "2026-06-25T00:00:00.000Z",
    status: "ok",
    ...overrides,
  };
}

describe("getServiceStatuses retired-row filter", () => {
  const NOW = Date.parse("2026-06-25T00:05:00.000Z");

  beforeEach(() => {
    execute.mockReset();
  });

  it("drops the orphaned `automation` aggregate row", async () => {
    execute.mockResolvedValue({
      rows: [row("web"), row("automation"), row("cron.render"), row("render-box")],
    });

    const services = await getServiceStatuses(NOW);
    const ids = services.map((service) => service.service);

    expect(ids).not.toContain("automation");

    expect(ids.filter((id) => ["web", "cron.render", "render-box"].includes(id))).toEqual([
      "web",
      "cron.render",
      "render-box",
    ]);
  });

  it("drops the retired `cron.artist-follow` row", async () => {
    execute.mockResolvedValue({
      rows: [row("cron.artist-sweep"), row("cron.artist-follow"), row("cron.enrich")],
    });

    const services = await getServiceStatuses(NOW);
    const ids = services.map((service) => service.service);

    expect(ids).not.toContain("cron.artist-follow");

    expect(ids.filter((id) => ["cron.artist-sweep", "cron.enrich"].includes(id))).toEqual([
      "cron.artist-sweep",
      "cron.enrich",
    ]);
  });

  it("leaves every reported row unchanged when no retired id is present", async () => {
    const reported = [row("web"), row("db"), row("hermes")];
    execute.mockResolvedValue({ rows: reported });

    const services = await getServiceStatuses(NOW);

    expect(
      services.filter((service) => reported.some((row) => row.service === service.service)),
    ).toEqual(reported);
  });
});

describe("getServiceStatuses report freshness", () => {
  const NOW = Date.parse("2026-07-30T12:00:00.000Z");

  beforeEach(() => {
    execute.mockReset();
  });

  it("degrades a green prober-owned row older than three 10m report cycles", async () => {
    execute.mockResolvedValue({
      rows: [
        row("cron.live", {
          checked_at: "2026-07-30T11:29:00.000Z",
          message: "fresh",
          since: "2026-07-30T10:00:00.000Z",
        }),
      ],
    });

    const services = await getServiceStatuses(NOW);
    const service = services.find((row) => row.service === "cron.live");

    expect(service?.status).toBe("degraded");
    expect(service?.message).toBe("last report is stale");
    expect(service?.checked_at).toBe("2026-07-30T11:29:00.000Z");
  });

  it("keeps a green prober-owned row fresh inside three 10m report cycles", async () => {
    execute.mockResolvedValue({
      rows: [
        row("cron.live", {
          checked_at: "2026-07-30T11:31:00.000Z",
          message: "fresh",
          since: "2026-07-30T10:00:00.000Z",
        }),
      ],
    });

    const services = await getServiceStatuses(NOW);
    const service = services.find((row) => row.service === "cron.live");

    expect(service?.status).toBe("ok");
    expect(service?.message).toBe("fresh");
  });
});

describe("getServiceStatuses expected-writer absence", () => {
  const NOW = Date.parse("2026-07-30T12:00:00.000Z");

  beforeEach(() => {
    execute.mockReset();
  });

  it("keeps an empty status store as a cold start without synthesizing rows", async () => {
    execute.mockResolvedValue({ rows: [] });

    await expect(getServiceStatuses(NOW)).resolves.toEqual([]);
  });

  it("synthesizes self-deploy-sonar as never reported when the roster id has no row", async () => {
    execute.mockResolvedValue({ rows: [row("web", { checked_at: "2026-07-30T11:55:00.000Z" })] });

    const services = await getServiceStatuses(NOW);
    const service = services.find((row) => row.service === "self-deploy-sonar");

    expect(service).toEqual({
      checked_at: null,
      latency_ms: null,
      message: "never reported",
      service: "self-deploy-sonar",
      since: null,
      status: "degraded",
    });
  });
});

describe("getServiceStatuses — a cron stuck on 'no runs yet' stops being green", () => {
  const NOW = Date.parse("2026-07-11T00:00:00.000Z");

  function noRuns(service: string, since: string): ServiceStatusRow {
    return {
      ...row(service),
      checked_at: "2026-07-10T23:55:00.000Z",
      message: "no runs yet",
      since,
      status: "ok",
    };
  }

  beforeEach(() => {
    execute.mockReset();
  });

  it("keeps a fresh no-runs-yet green (a box that just rebuilt has not ticked)", async () => {
    execute.mockResolvedValue({ rows: [noRuns("cron.enrich", "2026-07-10T23:00:00.000Z")] });

    const [service] = await getServiceStatuses(NOW);

    expect(service?.status).toBe("ok");
    expect(service?.message).toBe("no runs yet");
  });

  it("degrades a no-runs-yet that has persisted past the grace window (never deployed)", async () => {
    execute.mockResolvedValue({ rows: [noRuns("cron.enrich", "2026-07-07T00:00:00.000Z")] });

    const [service] = await getServiceStatuses(NOW);

    expect(service?.status).toBe("degraded");
    expect(service?.message).toMatch(/never run/i);
  });

  it("leaves a healthy running cron untouched", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          ...row("cron.enrich"),
          checked_at: "2026-07-10T23:55:00.000Z",
          message: "fresh",
        },
      ],
    });

    const [service] = await getServiceStatuses(NOW);

    expect(service?.status).toBe("ok");
    expect(service?.message).toBe("fresh");
  });
});
