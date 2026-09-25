import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_TOKEN, readJson, req, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const breakerStateMock = vi.fn();
const apifyBudgetMock = vi.fn();
const apifyEnabledMock = vi.fn();
const spotifySearchEnabledMock = vi.fn();
const gateMock = vi.fn();

vi.mock("./spotify-anchor-breaker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify-anchor-breaker")>();

  return { ...actual, getSpotifyAnchorBreakerState: () => breakerStateMock() };
});

vi.mock("./anchor-apify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./anchor-apify")>();

  return {
    ...actual,
    getAnchorApifyBudget: () => apifyBudgetMock(),
    isAnchorApifyEnabled: () => apifyEnabledMock(),
  };
});

vi.mock("./anchor-spotify-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./anchor-spotify-search")>();

  return {
    ...actual,
    anchorSpotifySearchGate: () => gateMock(),
    isAnchorSpotifySearchEnabled: () => spotifySearchEnabledMock(),
  };
});

const PATH = "/admin/catalogue/anchor/breaker";

const CLEAR = {
  cooldownRemainingMs: 0,
  reason: null,
  throttlesInWindow: 0,
  tripped: false,
  trippedAt: null,
};

const BUDGET_OPEN = {
  dailyRows: 300,
  day: "2026-09-20",
  remainingRows: 300,
  rowsSent: 0,
  spent: false,
};

beforeAll(() => {
  setAdminTokenEnv();
});

warmOrpcRouter();

beforeEach(() => {
  breakerStateMock.mockReset();
  apifyBudgetMock.mockReset();
  apifyEnabledMock.mockReset();
  spotifySearchEnabledMock.mockReset();
  gateMock.mockReset();
  breakerStateMock.mockResolvedValue(CLEAR);
  apifyBudgetMock.mockResolvedValue(BUDGET_OPEN);
  apifyEnabledMock.mockResolvedValue(true);
  spotifySearchEnabledMock.mockResolvedValue(false);
  gateMock.mockResolvedValue({ nextEligibleAt: null, reason: "flag_off" });
});

describe("oRPC get_spotify_anchor_breaker (GET /admin/catalogue/anchor/breaker)", () => {
  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "GET", undefined));

    expect(response?.status).toBe(401);
    expect(breakerStateMock).not.toHaveBeenCalled();
  });

  it("answers the AGENT token with the breaker AND which rungs are armed", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ...CLEAR,
      ok: true,
      rungs: {
        apifyBudget: BUDGET_OPEN,
        apifyEnabled: true,
        gateReason: "flag_off",
        nextEligibleAt: null,
        spotifySearchEnabled: false,
      },
    });
  });

  it("reports BOTH rungs disarmed — the state in which nothing can conclude", async () => {
    apifyEnabledMock.mockResolvedValue(false);
    spotifySearchEnabledMock.mockResolvedValue(false);

    const { handleOrpc } = await import("./orpc");
    const body = await readJson(await handleOrpc(req(PATH, "GET", AGENT_TOKEN)));

    expect(body).toMatchObject({
      rungs: { apifyEnabled: false, spotifySearchEnabled: false },
      tripped: false,
    });
  });

  it("carries the paid rung's DAILY ROW BRAKE — the fourth reason for silence", async () => {
    apifyBudgetMock.mockResolvedValue({
      dailyRows: 300,
      day: "2026-09-20",
      remainingRows: 0,
      rowsSent: 300,
      spent: true,
    });

    const { handleOrpc } = await import("./orpc");
    const body = await readJson(await handleOrpc(req(PATH, "GET", AGENT_TOKEN)));

    expect(body).toMatchObject({
      rungs: { apifyBudget: { remainingRows: 0, rowsSent: 300, spent: true }, apifyEnabled: true },
      tripped: false,
    });
  });

  it("keeps the rungs independent of the pause — a TRIPPED breaker over ARMED rungs", async () => {
    breakerStateMock.mockResolvedValue({
      cooldownRemainingMs: 1_800_000,
      reason: "throttled",
      throttlesInWindow: 5,
      tripped: true,
      trippedAt: "2026-07-22T12:00:00.000Z",
    });
    spotifySearchEnabledMock.mockResolvedValue(true);

    const { handleOrpc } = await import("./orpc");
    const body = await readJson(await handleOrpc(req(PATH, "GET", AGENT_TOKEN)));

    expect(body).toMatchObject({
      reason: "throttled",
      rungs: { apifyEnabled: true, spotifySearchEnabled: true },
      tripped: true,
    });
  });
});
