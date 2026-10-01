import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  readJson,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

const breakerStateMock = vi.fn();
const apifyBudgetMock = vi.fn();
const apifyEnabledMock = vi.fn();
const spotifySearchEnabledMock = vi.fn();
const gateMock = vi.fn();
const dailyCallsMock = vi.fn();
const essentialCallsMock = vi.fn();
const quotaHoldMock = vi.fn();
const consumerBudgetMock = vi.fn();
const consumerSpentMock = vi.fn();
const setConsumerBudgetMock = vi.fn();

vi.mock("./spotify-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify-budget")>();
  return {
    ...actual,
    readSpotifyConsumerDailyBudget: () => consumerBudgetMock(),
    readSpotifyConsumerDailyCallsSpent: () => consumerSpentMock(),
    readSpotifyDailyCallCount: () => dailyCallsMock(),
    readSpotifyEssentialDailyCalls: () => essentialCallsMock(),
    readSpotifyQuotaHoldUntil: () => quotaHoldMock(),
    setSpotifyConsumerDailyBudget: (...args: unknown[]) => setConsumerBudgetMock(...args),
  };
});

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
  dailyCallsMock.mockReset();
  essentialCallsMock.mockReset();
  quotaHoldMock.mockReset();
  consumerBudgetMock.mockReset();
  consumerSpentMock.mockReset();
  setConsumerBudgetMock.mockReset();
  breakerStateMock.mockResolvedValue(CLEAR);
  apifyBudgetMock.mockResolvedValue(BUDGET_OPEN);
  apifyEnabledMock.mockResolvedValue(true);
  spotifySearchEnabledMock.mockResolvedValue(false);
  gateMock.mockResolvedValue({ nextEligibleAt: null, reason: "flag_off" });
  dailyCallsMock.mockResolvedValue(7);
  essentialCallsMock.mockResolvedValue(3);
  quotaHoldMock.mockResolvedValue(null);
  consumerBudgetMock.mockResolvedValue(700);
  consumerSpentMock.mockResolvedValue(0);
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
      consumerBudgets: {
        anchor: { callsSpent: 0, dailyBudget: 700 },
        artist_images: { callsSpent: 0, dailyBudget: 700 },
        public_search: { callsSpent: 0, dailyBudget: 700 },
      },
      essentialDailyCalls: 3,
      ok: true,
      quotaHoldState: "clear",
      quotaHoldUntil: null,
      rungs: {
        apifyBudget: BUDGET_OPEN,
        apifyEnabled: true,
        gateReason: "flag_off",
        nextEligibleAt: null,
        spotifySearchEnabled: false,
      },
      spotifyDailyCalls: 7,
    });
  });

  it("keeps the anchor gate readable when daily usage telemetry is unavailable", async () => {
    dailyCallsMock.mockRejectedValue(new Error("counter unavailable"));
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "GET", AGENT_TOKEN));
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ spotifyDailyCalls: null, tripped: false });
  });

  it("keeps the breaker readable when its stored quota hold is corrupt", async () => {
    quotaHoldMock.mockRejectedValue(new Error("Spotify quota hold is unreadable"));
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "GET", AGENT_TOKEN));
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      quotaHoldState: "unknown",
      quotaHoldUntil: null,
    });
  });

  it("keeps the breaker readable when a consumer budget read fails", async () => {
    consumerBudgetMock.mockRejectedValue(new Error("counter unavailable"));
    consumerSpentMock.mockRejectedValue(new Error("counter unavailable"));
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "GET", AGENT_TOKEN));
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      consumerBudgets: {
        anchor: { callsSpent: null, dailyBudget: null },
        artist_images: { callsSpent: null, dailyBudget: null },
        public_search: { callsSpent: null, dailyBudget: null },
      },
    });
  });

  it("reports a quota hold to the box through the breaker contract", async () => {
    const { handleOrpc } = await import("./orpc");
    gateMock.mockResolvedValue({
      nextEligibleAt: "2026-09-20T09:00:00.000Z",
      reason: "quota_hold",
    });
    const response = await handleOrpc(req(PATH, "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      rungs: {
        gateReason: "quota_hold",
        nextEligibleAt: "2026-09-20T09:00:00.000Z",
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

describe("oRPC set_spotify_consumer_budget", () => {
  it("lets the operator set a cap and rejects the agent", async () => {
    const { handleOrpc } = await import("./orpc");
    const path = "/admin/catalogue/spotify-budget";
    const input = { consumer: "anchor", dailyBudget: 700 };
    expect((await handleOrpc(req(path, "PUT", AGENT_TOKEN, input)))?.status).toBe(403);
    expect(setConsumerBudgetMock).not.toHaveBeenCalled();
    const response = await handleOrpc(req(path, "PUT", OPERATOR_TOKEN, input));
    expect(response?.status).toBe(200);
    expect(setConsumerBudgetMock).toHaveBeenCalledWith("anchor", 700);
  });
});
