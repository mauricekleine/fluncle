import { beforeEach, describe, expect, it, vi } from "vitest";

const chargeRateLimit = vi.hoisted(() => vi.fn());
const reads = vi.hoisted(() => ({
  countAllTracks: vi.fn(async (_now: Date) => 12),
  listTracksHubPage: vi.fn(async (_filters: unknown, _page: number, _now: Date) => ({ total: 3 })),
  listTracksHubSoundPage: vi.fn(),
  listTracksHubYearLane: vi.fn(async (_filters: unknown, _now: Date) => []),
}));

vi.mock("@/lib/server/tracks-hub", () => reads);
vi.mock("@/lib/server/rate-limit", () => ({ chargeRateLimit }));
vi.mock("@/lib/server/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/env")>()),
  readOptionalEnv: async () => undefined,
}));

import { SEARCH_STYLES } from "@/lib/search-styles";
import { ApiError } from "@/lib/server/spotify";
import { readTracksHubAtOneTime, readTracksHubSoundAtOneTime } from "./-tracks-hub-reads";

const liquid = SEARCH_STYLES[0];
const request = new Request("https://www.fluncle.com/tracks?sound=liquid");
const instant = new Date("2026-09-25T12:00:00.000Z");
const clock = () => instant;

describe("tracks hub release boundary", () => {
  it("passes one captured instant to the page, year lane and held total", async () => {
    let ticks = 0;
    const clock = () => {
      ticks += 1;
      return new Date(ticks === 1 ? "2026-07-20T23:59:59.999Z" : "2026-07-21T00:00:00.000Z");
    };

    await readTracksHubAtOneTime({ label: "Hospital" }, 1, false, true, clock);

    expect(ticks).toBe(1);
    const instant = new Date("2026-07-20T23:59:59.999Z");
    expect(reads.listTracksHubPage).toHaveBeenCalledWith({ label: "Hospital" }, 1, instant);
    expect(reads.listTracksHubYearLane).toHaveBeenCalledWith({ label: "Hospital" }, instant);
    expect(reads.countAllTracks).toHaveBeenCalledWith(instant);
  });
});

describe("a ?sound= page spends the shared search budget", () => {
  beforeEach(() => {
    chargeRateLimit.mockReset();
    reads.listTracksHubPage.mockClear();
    reads.listTracksHubSoundPage.mockReset();
    reads.listTracksHubSoundPage.mockResolvedValue({ anchors: ["Calibre"], hub: {}, ranked: true });
  });

  it("charges the request and holds the ranking for the budget's verdict", async () => {
    const charge = { requireAllowed: vi.fn(async () => undefined), throwIfLimited: vi.fn() };

    chargeRateLimit.mockResolvedValue(charge);

    const [page] = await readTracksHubSoundAtOneTime({ sound: "liquid" }, liquid, 1, {
      clock,
      request,
    });

    expect(chargeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "search_archive", limit: 30, request, windowMs: 60_000 }),
    );
    expect(reads.listTracksHubSoundPage).toHaveBeenCalledWith(
      { sound: "liquid" },
      liquid,
      1,
      instant,
      {
        beforeVector: charge.requireAllowed,
      },
    );
    expect(charge.throwIfLimited).toHaveBeenCalled();
    expect(page.ranked).toBe(true);
  });

  it("reads the newest-first page, flagged limited, when the verdict refuses the ranking", async () => {
    const refused = new ApiError("rate_limited", "Too many requests.", 429);

    chargeRateLimit.mockResolvedValue({
      requireAllowed: vi.fn(async () => {
        throw refused;
      }),
      throwIfLimited: vi.fn(),
    });
    reads.listTracksHubSoundPage.mockImplementation(
      async (
        _filters: unknown,
        _style: unknown,
        _page: number,
        _now: Date,
        options: { beforeVector?: () => Promise<void> },
      ) => {
        await options.beforeVector?.();

        return { anchors: ["Calibre"], hub: {}, ranked: true };
      },
    );

    const [page] = await readTracksHubSoundAtOneTime(
      { key: "A minor", sound: "liquid" },
      liquid,
      2,
      {
        clock,
        request,
      },
    );

    expect(page).toEqual({ anchors: [], hub: { total: 3 }, limited: true, ranked: false });
    expect(reads.listTracksHubPage).toHaveBeenCalledWith({ key: "A minor" }, 2, instant);
  });

  it("reads the newest-first page when the budget is already spent", async () => {
    chargeRateLimit.mockRejectedValue(new ApiError("rate_limited", "Too many requests.", 429));

    const [page] = await readTracksHubSoundAtOneTime({ sound: "liquid" }, liquid, 1, {
      clock,
      request,
    });

    expect(page.limited).toBe(true);
    expect(reads.listTracksHubSoundPage).not.toHaveBeenCalled();
  });

  it("lets any other fault through", async () => {
    chargeRateLimit.mockResolvedValue({ requireAllowed: vi.fn(), throwIfLimited: vi.fn() });
    reads.listTracksHubSoundPage.mockRejectedValue(new Error("turso down"));

    await expect(
      readTracksHubSoundAtOneTime({ sound: "liquid" }, liquid, 1, { clock, request }),
    ).rejects.toThrow("turso down");
  });
});
