import { describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  countAllTracks: vi.fn(async (_now: Date) => 12),
  listTracksHubPage: vi.fn(async (_filters: unknown, _page: number, _now: Date) => ({ total: 3 })),
  listTracksHubYearLane: vi.fn(async (_filters: unknown, _now: Date) => []),
}));

vi.mock("@/lib/server/tracks-hub", () => reads);

import { readTracksHubAtOneTime } from "./-tracks-hub-reads";

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
