import { describe, expect, it } from "vitest";

import { makeRng, placeAsteroids, placeBlackHoles, placeStars } from "./placement";
import { type SimInput, createSim, drainEvents, registerBehavior, stepSim } from "./sim";
import { type FrontierEntity, type GameTrack, isStar } from "./types";

const STILL: SimInput = { boost: false, steer: 0 };

function manyTracks(count: number): GameTrack[] {
  return Array.from({ length: count }, (_, index) => ({
    addedAt: "2026-05-30T00:00:00.000Z",
    artists: ["Artist"],
    logId: `${100 + index}.0.1A`,
    spotifyUrl: `https://open.spotify.com/track/${index}`,
    title: `Banger ${index}`,
    trackId: `track-${index}`,
  }));
}

// The entity spine: stars are deterministic kind:"star" entities (the parallel
// collected[] is folded in), the session RNG is reproducible, and the frontier
// behavior table dispatches per kind over a drifting entity array.

const TRACKS: GameTrack[] = [
  {
    addedAt: "2026-05-30T00:00:00.000Z",
    artists: ["Artist One", "Artist Two"],
    logId: "241.0.1A",
    spotifyUrl: "https://open.spotify.com/track/a",
    title: "First Banger",
    trackId: "track-a",
  },
  {
    addedAt: "2026-06-02T00:00:00.000Z",
    artists: ["Artist Three"],
    logId: "244.0.1B",
    spotifyUrl: "https://open.spotify.com/track/b",
    title: "Second Banger",
    trackId: "track-b",
  },
];

describe("placeStars", () => {
  it("is deterministic for a given catalogue", () => {
    expect(placeStars(TRACKS)).toEqual(placeStars(TRACKS));
  });

  it("places stars as uncollected kind:'star' entities at their ring radius", () => {
    const stars = placeStars(TRACKS);

    for (const star of stars) {
      expect(star.kind).toBe("star");
      expect(star.collected).toBe(false);
      expect(star.vx).toBe(0);
      expect(star.vy).toBe(0);
      expect(star.id).toBe(star.logId);
      // Placed on its ring: world position matches the radial distance.
      expect(Math.hypot(star.x, star.y)).toBeCloseTo(star.radius, 5);
      expect(isStar(star)).toBe(true);
    }

    // The frontier sector pushes the newer finding to a larger ring.
    const [first, second] = stars;
    if (first === undefined || second === undefined) {
      throw new Error("expected at least two placed stars");
    }
    expect(second.radius).toBeGreaterThan(first.radius);
  });
});

describe("makeRng", () => {
  it("reproduces a sequence for a seed and diverges for another", () => {
    const a = makeRng(1234);
    const b = makeRng(1234);
    const c = makeRng(5678);

    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    const seqC = [c(), c(), c()];

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);

    for (const value of [...seqA, ...seqC]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("frontier behavior table", () => {
  it("drifts entities on vx/vy and dispatches the registered per-kind behavior", () => {
    let stepped = 0;

    registerBehavior("roadster", {
      onStep: (entity) => {
        stepped += 1;
        // Behaviors can read/modify the entity each step.
        entity.spin = (entity.spin ?? 0) + 1;
      },
    });

    const sim = createSim([]);
    const roadster: FrontierEntity = {
      id: "roadster:test",
      kind: "roadster",
      radius: 0,
      spin: 0,
      vOffset: 0,
      vx: 12,
      vy: -4,
      x: 0,
      y: 100,
    };

    sim.entities = [roadster];
    stepSim(sim, { boost: false, steer: 0 }, 1);

    expect(stepped).toBe(1);
    expect(roadster.spin).toBe(1);
    // Drift integrated over a 1s step.
    expect(roadster.x).toBeCloseTo(12, 5);
    expect(roadster.y).toBeCloseTo(96, 5);
  });
});

describe("black holes", () => {
  const SEED = 12345;

  it("places a deterministic teleport network, never on a banger", () => {
    const stars = placeStars(manyTracks(16));
    const a = placeBlackHoles(stars, SEED);
    const b = placeBlackHoles(stars, SEED);

    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(1);

    for (const hole of a) {
      expect(hole.kind).toBe("blackhole");
      expect(hole.exits).toHaveLength(4);

      // The navigable-lane invariant: no hole sits on the route to a star.
      for (const star of stars) {
        expect(Math.hypot(star.x - hole.x, star.y - hole.y)).toBeGreaterThan(150);
      }
    }
  });

  it("stays empty below the finding-count threshold", () => {
    expect(placeBlackHoles(placeStars(manyTracks(8)), SEED)).toEqual([]);
  });

  it("pulls the ship in within the influence radius", () => {
    const sim = createSim(placeStars(manyTracks(16)), {
      frontier: { blackHoles: true },
      seed: SEED,
    });
    const hole = sim.entities.find((entity) => entity.kind === "blackhole");

    expect(hole).toBeDefined();

    if (!hole) {
      return;
    }

    sim.ship.x = hole.x - 150;
    sim.ship.y = hole.y;
    sim.ship.vx = 0;
    sim.ship.vy = 0;
    stepSim(sim, STILL, 1 / 60);

    // The hole is at +x; the pull gives the ship velocity toward it.
    expect(sim.ship.vx).toBeGreaterThan(0);
  });

  it("warps to an exit with a slingshot top-up at the horizon, never ending the run", () => {
    const sim = createSim(placeStars(manyTracks(16)), {
      frontier: { blackHoles: true },
      seed: SEED,
    });
    const hole = sim.entities.find((entity) => entity.kind === "blackhole");

    expect(hole).toBeDefined();

    if (!hole) {
      return;
    }

    const exits = hole.exits ?? [];

    sim.ship.x = hole.x;
    sim.ship.y = hole.y;
    sim.ship.fuel = 5;
    stepSim(sim, STILL, 1 / 60);

    expect(sim.events.map((event) => event.kind)).toContain("warped");
    expect(sim.phase).toBe("flying");
    // Topped up to the slingshot floor (minus the single frame's burn).
    expect(sim.ship.fuel).toBeGreaterThan(sim.config.tankCapacity * 0.55);

    const landedOnExit = exits.some(
      (exit) => Math.hypot(exit.x - sim.ship.x, exit.y - sim.ship.y) < 1,
    );

    expect(landedOnExit).toBe(true);
  });
});

describe("asteroids + the auto-clearing laser", () => {
  const SEED = 4242;

  function asteroidAt(x: number, y: number, bodyRadius = 16): FrontierEntity {
    return {
      bodyRadius,
      id: `asteroid:test:${x},${y}`,
      kind: "asteroid",
      radius: Math.hypot(x, y),
      vOffset: 0,
      vx: 0,
      vy: 0,
      x,
      y,
    };
  }

  function lasersSim() {
    return createSim(placeStars(manyTracks(16)), { frontier: { asteroids: true }, seed: SEED });
  }

  it("places deterministic asteroid waves in the far stretches", () => {
    const stars = placeStars(manyTracks(16));

    expect(placeAsteroids(stars)).toEqual(placeAsteroids(stars));
    expect(placeAsteroids(stars).length).toBeGreaterThan(0);

    for (const rock of placeAsteroids(stars)) {
      expect(rock.kind).toBe("asteroid");
      expect(rock.bodyRadius).toBeGreaterThan(0);
    }
  });

  it("auto-fires at a rock dead ahead and clears it (bolts never touch stars)", () => {
    const sim = lasersSim();

    // Isolate one rock directly ahead (the ship launches heading toward -y).
    sim.entities = [asteroidAt(sim.ship.x, sim.ship.y - 220)];

    const kinds = new Set<string>();

    for (let frame = 0; frame < 90; frame++) {
      stepSim(sim, STILL, 1 / 60);

      for (const event of drainEvents(sim)) {
        kinds.add(event.kind);
      }

      if (kinds.has("bolt-hit")) {
        break;
      }
    }

    expect(kinds.has("bolt-fired")).toBe(true);
    expect(kinds.has("bolt-hit")).toBe(true);
    expect(sim.entities.some((entity) => entity.kind === "asteroid")).toBe(false);
    // A bolt over a banger does nothing: bolts only ever resolve against rocks.
    expect(kinds.has("logged")).toBe(false);
    expect(sim.collectedCount).toBe(0);
  });

  it("a hull hit costs fuel but never ends the run", () => {
    const sim = lasersSim();

    sim.ship.fuel = 80;
    sim.entities = [asteroidAt(sim.ship.x, sim.ship.y)];
    stepSim(sim, STILL, 1 / 60);

    expect(sim.events.map((event) => event.kind)).toContain("asteroid-hit");
    expect(sim.ship.fuel).toBeLessThan(80);
    expect(sim.ship.fuel).toBeGreaterThan(60);
    expect(sim.phase).toBe("flying");
    expect(sim.entities.some((entity) => entity.kind === "asteroid")).toBe(false);
  });
});
