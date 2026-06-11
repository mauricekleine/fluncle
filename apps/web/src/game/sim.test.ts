import { describe, expect, it } from "vitest";

import {
  type SimInput,
  type SimState,
  createSim,
  departOrbit,
  drainEvents,
  resetSim,
  stepSim,
} from "./sim";
import { type Star } from "./types";

// The pure-sim contract this game shipped without: fuel burns and refuels, a
// star parks and logs you, a dry tank drifts → tows → restarts, and N/N flips
// the run home. All deterministic, state-in/state-out — no canvas, no audio.

function makeStar(logId: string, x: number, y: number): Star {
  return {
    angle: 0,
    artistLine: "Some Artist",
    collected: false,
    id: logId,
    kind: "star",
    logId,
    radius: Math.hypot(x, y),
    sector: 0,
    spotifyUrl: `https://open.spotify.com/track/${logId}`,
    title: "Some Banger",
    trackId: `track-${logId}`,
    vOffset: 0,
    vx: 0,
    vy: 0,
    x,
    y,
  };
}

const FLY: SimInput = { boost: false, steer: 0 };

function stepFor(state: SimState, seconds: number, input: SimInput = FLY, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) {
    stepSim(state, input, dt);
  }
}

describe("createSim", () => {
  it("starts flying, full tank, nothing logged, no frontier", () => {
    const sim = createSim([makeStar("241.0.1A", 800, 0)]);

    expect(sim.phase).toBe("flying");
    expect(sim.collectedCount).toBe(0);
    expect(sim.ship.fuel).toBe(sim.config.tankCapacity);
    expect(sim.orbitIndex).toBe(-1);
    expect(sim.entities).toEqual([]);
    expect(sim.stars[0].collected).toBe(false);
  });
});

describe("fuel", () => {
  it("burns in flight and boost burns faster", () => {
    const cruise = createSim([makeStar("241.0.1A", 4000, 0)]);
    const boost = createSim([makeStar("241.0.1A", 4000, 0)]);

    stepFor(cruise, 3);
    stepFor(boost, 3, { boost: true, steer: 0 });

    expect(cruise.ship.fuel).toBeLessThan(cruise.config.tankCapacity);
    expect(boost.ship.fuel).toBeLessThan(cruise.ship.fuel);
  });

  it("warns low, then runs dry into adrift, then tows home and restarts", () => {
    const sim = createSim([makeStar("241.0.1A", 3000, 0)]);

    // Already under the low-fuel line; burn it to empty.
    sim.ship.fuel = 2;

    let guard = 0;

    while (sim.phase !== "adrift" && guard < 2000) {
      stepSim(sim, FLY, 1 / 60);
      guard += 1;
    }

    expect(collectKinds(sim)).toContain("low-fuel");
    expect(sim.phase).toBe("adrift");

    // The dead-stick drift, then the tow + restart (one death banked). Stop
    // the moment the reset lands, before flight burns the fresh tank.
    guard = 0;

    while (sim.deaths === 0 && guard < 2000) {
      stepSim(sim, FLY, 1 / 60);
      guard += 1;
    }

    expect(sim.phase).toBe("flying");
    expect(sim.deaths).toBe(1);
    expect(sim.ship.fuel).toBe(sim.config.tankCapacity);
    expect(sim.collectedCount).toBe(0);
  });
});

describe("orbit", () => {
  it("parking on a star logs it, refuels while fresh, and departs to flying", () => {
    const sim = createSim([makeStar("241.0.1A", 800, 0)]);

    sim.ship.x = 800;
    sim.ship.y = 0;
    sim.ship.fuel = 20;
    stepSim(sim, FLY, 1 / 60);

    expect(sim.phase).toBe("orbiting");
    expect(sim.stars[0].collected).toBe(true);
    expect(sim.collectedCount).toBe(1);
    expect(sim.orbitFresh).toBe(true);
    expect(collectKinds(sim)).toContain("logged");

    const before = sim.ship.fuel;

    stepFor(sim, 2);
    expect(sim.ship.fuel).toBeGreaterThan(before);

    departOrbit(sim);
    expect(sim.phase).toBe("flying");
    expect(sim.orbitIndex).toBe(-1);
  });

  it("a revisited star does not re-log or re-count", () => {
    const sim = createSim([makeStar("241.0.1A", 800, 0)]);

    sim.ship.x = 800;
    sim.ship.y = 0;
    stepSim(sim, FLY, 1 / 60);
    drainEvents(sim);
    departOrbit(sim);

    sim.ship.x = 800;
    sim.ship.y = 0;
    stepSim(sim, FLY, 1 / 60);

    expect(sim.collectedCount).toBe(1);
    expect(sim.orbitFresh).toBe(false);
    expect(collectKinds(sim)).not.toContain("logged");
  });
});

describe("win", () => {
  it("flips home at N/N back at Earth, and emits all-found on the last log", () => {
    const sim = createSim([makeStar("241.0.1A", 800, 0)]);

    sim.ship.x = 800;
    sim.ship.y = 0;
    stepSim(sim, FLY, 1 / 60);
    expect(collectKinds(sim)).toContain("all-found");
    departOrbit(sim);

    // Home with the full log: the run flips to the fly-home win.
    sim.ship.x = 0;
    sim.ship.y = 0;
    stepSim(sim, FLY, 1 / 60);

    expect(sim.atEarth).toBe(true);
    expect(sim.phase).toBe("home");
    expect(collectKinds(sim)).toContain("home");
  });
});

describe("resetSim", () => {
  it("clears the log and rebuilds the same galaxy", () => {
    const sim = createSim([makeStar("241.0.1A", 800, 0), makeStar("242.0.1B", 0, 900)]);

    sim.stars[0].collected = true;
    sim.collectedCount = 1;
    sim.ship.fuel = 3;

    resetSim(sim, false);

    expect(sim.collectedCount).toBe(0);
    expect(sim.stars.every((star) => !star.collected)).toBe(true);
    expect(sim.ship.fuel).toBe(sim.config.tankCapacity);
    expect(sim.deaths).toBe(0);
  });
});

function collectKinds(state: SimState): string[] {
  return state.events.map((event) => event.kind);
}
