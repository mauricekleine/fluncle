import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  readJson,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

const settings = vi.hoisted(() => new Map<string, string>());

vi.mock("./settings", () => ({
  getSetting: (key: string) => Promise.resolve(settings.get(key)),
  setSetting: (key: string, value: string) => {
    settings.set(key, value);

    return Promise.resolve();
  },
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getTelemetryDb: () => Promise.resolve(undefined) };
});

beforeAll(setAdminTokenEnv);

warmOrpcRouter();

beforeEach(() => {
  settings.clear();
});

describe("the Turso usage ops' auth tiers", () => {
  it("lets the operator move the alert line", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/costs/turso-usage/threshold", "PUT", OPERATOR_TOKEN, { thresholdUsd: 75 }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, thresholdUsd: 75 });
    expect(settings.get("turso_usage_alert_threshold_usd")).toBe("75");
  });

  it("refuses the agent token on the alert line", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/costs/turso-usage/threshold", "PUT", AGENT_TOKEN, { thresholdUsd: 75 }),
    );

    expect(response?.status).toBe(403);
    expect(settings.size).toBe(0);
  });

  it("lets the agent token read the board", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/costs/turso-usage", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      available: false,
      ok: true,
      thresholdUsd: 50,
    });
  });

  it("401s an anonymous record", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/costs/turso-usage", "POST", undefined, {
        databases: [],
        observedAt: "2026-09-28T00:00:00.000Z",
        plan: { name: "scaler", overages: true },
        upcomingInvoiceUsd: null,
        usage: { bytesSynced: 0, rowsRead: 0, rowsWritten: 0, storageBytes: 0 },
      }),
    );

    expect(response?.status).toBe(401);
  });
});
