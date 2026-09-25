import { beforeEach, describe, expect, it, vi } from "vitest";

const chargeRateLimit = vi.hoisted(() => vi.fn());
const searchArchive = vi.hoisted(() => vi.fn());
const searchLikeTrack = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/rate-limit", () => ({ chargeRateLimit }));
vi.mock("@/lib/server/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/env")>()),
  readOptionalEnv: async () => undefined,
}));
vi.mock("@/lib/server/search", () => ({ searchArchive, searchLikeTrack }));
vi.mock("@sentry/cloudflare", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/server/log", () => ({ logEvent: vi.fn() }));

import { ApiError } from "@/lib/server/spotify";
import { resolveSearchPageData } from "./-search-page-data";

const request = new Request("https://www.fluncle.com/search?q=liquid");
const answer = { degraded: false, entities: [], kind: "token", results: [] };

function allowed() {
  const charge = { requireAllowed: vi.fn(async () => undefined), throwIfLimited: vi.fn() };

  chargeRateLimit.mockResolvedValue(charge);

  return charge;
}

beforeEach(() => {
  chargeRateLimit.mockReset();
  searchArchive.mockReset();
  searchLikeTrack.mockReset();
  searchArchive.mockResolvedValue(answer);
  searchLikeTrack.mockResolvedValue({ ...answer, kind: "sonic" });
});

describe("resolveSearchPageData charges the search_archive budget on every page resolution", () => {
  it("charges a live keystroke to the shared per-IP budget", async () => {
    allowed();

    await resolveSearchPageData("moonlit cur", { live: true, request });

    expect(chargeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "search_archive", limit: 30, request, windowMs: 60_000 }),
    );
  });

  it("charges the sonic view of one track", async () => {
    const charge = allowed();

    await resolveSearchPageData(undefined, { like: "t1", request });

    expect(chargeRateLimit).toHaveBeenCalledOnce();
    expect(searchLikeTrack).toHaveBeenCalledWith(
      expect.objectContaining({ beforeVector: charge.requireAllowed }),
    );
    expect(charge.throwIfLimited).toHaveBeenCalled();
  });

  it("holds every vector pass of a typed query for the budget's verdict", async () => {
    const charge = allowed();

    await resolveSearchPageData("liquid", { live: true, request });

    expect(searchArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeModel: charge.requireAllowed,
        beforeVector: charge.requireAllowed,
      }),
    );
  });

  it("gates a committed sentence's model tier on the budget's verdict", async () => {
    const charge = allowed();

    await resolveSearchPageData("tracks in A minor above 170 bpm", { request });

    expect(searchArchive).toHaveBeenCalledWith(
      expect.objectContaining({ beforeModel: charge.requireAllowed }),
    );
    expect(charge.throwIfLimited).toHaveBeenCalled();
  });

  it("names a spent budget as its own state, never an empty answer or a fault", async () => {
    chargeRateLimit.mockRejectedValue(new ApiError("rate_limited", "Too many requests.", 429));

    await expect(resolveSearchPageData("liquid", { request })).resolves.toEqual({
      status: "limited",
    });
    expect(searchArchive).not.toHaveBeenCalled();
  });

  it("charges nothing for the zero state", async () => {
    await expect(resolveSearchPageData("a", { request })).resolves.toEqual({ status: "blank" });
    expect(chargeRateLimit).not.toHaveBeenCalled();
  });
});
