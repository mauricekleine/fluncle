import { describe, expect, it } from "vitest";
import { applyLifetimeMarkers, collectLifetimeLogIds, mergeProgress } from "./progress";
import { createSim, resetSim } from "./sim";
import { type Star } from "./types";

function makeStar(logId: string): Star {
  return {
    angle: 0,
    artistLine: "Some Artist",
    collected: false,
    id: logId,
    kind: "star",
    logId,
    radius: 800,
    sector: 0,
    spotifyUrl: `https://open.spotify.com/track/${logId}`,
    title: "Some Banger",
    trackId: `track-${logId}`,
    vOffset: 0,
    vx: 0,
    vy: 0,
    x: 800,
    y: 0,
  };
}

describe("Galaxy lifetime progress", () => {
  it("a lifetime log arrives COLLECTED and seeds the counter (logged IS collected)", () => {
    const stars = [makeStar("241.0.1A"), makeStar("242.0.1B")];

    applyLifetimeMarkers(stars, ["241.0.1A"]);

    const sim = createSim(stars);

    const firstStar = sim.stars[0];
    if (firstStar === undefined) {
      throw new Error("expected at least one star");
    }
    expect(firstStar.lifetimeLogged).toBe(true);
    expect(firstStar.collected).toBe(true);
    expect(sim.collectedCount).toBe(1);
  });

  it("tow or manual restart keeps the log — nobody re-collects, the universe grows", () => {
    const sim = createSim([makeStar("241.0.1A"), makeStar("242.0.1B")]);

    const [firstStar, secondStar] = [sim.stars[0], sim.stars[1]];
    if (firstStar === undefined || secondStar === undefined) {
      throw new Error("expected two stars");
    }
    // The first star was logged (any run marks it lifetime at collect time); the
    // second was never reached.
    firstStar.lifetimeLogged = true;
    firstStar.collected = true;
    sim.collectedCount = 1;

    resetSim(sim, false);

    expect(firstStar.collected).toBe(true);
    expect(firstStar.lifetimeLogged).toBe(true);
    expect(secondStar.collected).toBe(false);
    expect(sim.collectedCount).toBe(1);
    expect(collectLifetimeLogIds(sim)).toEqual(["241.0.1A"]);
  });

  it("unions local and server progress", () => {
    expect(
      mergeProgress(
        { collectedLogIds: ["241.0.1A"], deaths: 1 },
        { collectedLogIds: ["242.0.1B"], wins: 1 },
      ),
    ).toEqual({
      collectedLogIds: ["241.0.1A", "242.0.1B"],
      deaths: 1,
      wins: 1,
    });
  });
});
