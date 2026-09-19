import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_TOKEN, readJson, req, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

// The `get_spotify_anchor_breaker` READ, driven end-to-end through `handleOrpc`. What is under test
// is the one thing this read is for: answering "why is the anchor waterfall quiet?" completely.
// Silence has two causes that look identical from outside — the shared-app throttle breaker PAUSING
// the Spotify search rungs, and the operator flags leaving those rungs (or the paid Apify fallback)
// DISARMED — and only the first was ever visible. The flags had no read surface at all, so their
// state could only be inferred from what the sweep failed to do.
//
// The breaker state and the two flag reads are the mocked edges; the router, the auth spine and the
// response envelope are real.

const breakerStateMock = vi.fn();
const apifyEnabledMock = vi.fn();
const spotifySearchEnabledMock = vi.fn();

vi.mock("./spotify-anchor-breaker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify-anchor-breaker")>();

  return { ...actual, getSpotifyAnchorBreakerState: () => breakerStateMock() };
});

vi.mock("./anchor-apify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./anchor-apify")>();

  return { ...actual, isAnchorApifyEnabled: () => apifyEnabledMock() };
});

vi.mock("./anchor-spotify-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./anchor-spotify-search")>();

  return { ...actual, isAnchorSpotifySearchEnabled: () => spotifySearchEnabledMock() };
});

const PATH = "/admin/catalogue/anchor/breaker";

const CLEAR = {
  cooldownRemainingMs: 0,
  reason: null,
  throttlesInWindow: 0,
  tripped: false,
  trippedAt: null,
};

beforeAll(() => {
  setAdminTokenEnv();
});

warmOrpcRouter();

beforeEach(() => {
  breakerStateMock.mockReset();
  apifyEnabledMock.mockReset();
  spotifySearchEnabledMock.mockReset();
  breakerStateMock.mockResolvedValue(CLEAR);
  apifyEnabledMock.mockResolvedValue(true);
  spotifySearchEnabledMock.mockResolvedValue(false);
});

describe("oRPC get_spotify_anchor_breaker (GET /admin/catalogue/anchor/breaker)", () => {
  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "GET", undefined));

    expect(response?.status).toBe(401);
    expect(breakerStateMock).not.toHaveBeenCalled();
  });

  it("answers the AGENT token with the breaker AND which rungs are armed", async () => {
    // The box's own sweep is entitled to this read — the `get_capture_budget` precedent.
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ...CLEAR,
      ok: true,
      rungs: { apifyEnabled: true, spotifySearchEnabled: false },
    });
  });

  it("reports BOTH rungs disarmed — the state in which nothing can conclude", async () => {
    // The other side of the same field: with the paid fallback off and the dark search flag off, no
    // rung in the waterfall can settle a row's question, and a clear breaker says nothing about it.
    apifyEnabledMock.mockResolvedValue(false);
    spotifySearchEnabledMock.mockResolvedValue(false);

    const { handleOrpc } = await import("./orpc");
    const body = await readJson(await handleOrpc(req(PATH, "GET", AGENT_TOKEN)));

    expect(body).toMatchObject({
      rungs: { apifyEnabled: false, spotifySearchEnabled: false },
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
