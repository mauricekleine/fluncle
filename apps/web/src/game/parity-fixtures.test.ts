import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { fnv1a, makeRng, placeFrontier, placeStars } from "./placement";
import {
  createSim,
  departOrbit,
  drainEvents,
  nearestCarrier,
  radarBlips,
  resetSim,
  scopeContacts,
  stepSim,
} from "./sim";
import { type GameTrack } from "./types";

type PlacementFixture = {
  fnv1a: Record<string, number>;
  rng1234: number[];
  tracks: GameTrack[];
  stars: Array<{
    angle: number;
    artistLine: string;
    collected: boolean;
    id: string;
    kind: "star";
    logId: string;
    radius: number;
    sector: number;
    spotifyUrl: string;
    title: string;
    trackId: string;
    vOffset: number;
    x: number;
    y: number;
  }>;
};

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../ssh/internal/galaxy/testdata/placement.json", import.meta.url)),
    "utf8",
  ),
) as PlacementFixture;

type SimFixture = {
  seed: number;
  snapshots: unknown[];
  step: number;
  tracks: GameTrack[];
};

const simFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../ssh/internal/galaxy/testdata/sim_stars.json", import.meta.url)),
    "utf8",
  ),
) as SimFixture;

type FrontierFixture = {
  entities: unknown[];
  frontier: {
    asteroids?: boolean;
    blackHoles?: boolean;
    setDressing?: boolean;
  };
  seed: number;
  snapshots: unknown[];
  tracks: GameTrack[];
};

const frontierFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../ssh/internal/galaxy/testdata/frontier_contacts.json", import.meta.url),
    ),
    "utf8",
  ),
) as FrontierFixture;

describe("SSH placement parity fixture", () => {
  it("matches the TypeScript placement authority", () => {
    for (const [input, expected] of Object.entries(fixture.fnv1a)) {
      expect(fnv1a(input)).toBe(expected);
    }

    const rng = makeRng(1234);

    for (const expected of fixture.rng1234) {
      expect(rng()).toBe(expected);
    }

    const stars = placeStars(fixture.tracks);

    expect(
      stars.map((star) => ({
        angle: star.angle,
        artistLine: star.artistLine,
        collected: star.collected,
        id: star.id,
        kind: star.kind,
        logId: star.logId,
        radius: star.radius,
        sector: star.sector,
        spotifyUrl: star.spotifyUrl,
        title: star.title,
        trackId: star.trackId,
        vOffset: star.vOffset,
        x: star.x,
        y: star.y,
      })),
    ).toEqual(fixture.stars);
  });
});

describe("SSH star-flight sim parity fixture", () => {
  it("matches the TypeScript sim authority", () => {
    const sim = createSim(placeStars(simFixture.tracks), { seed: simFixture.seed });
    const snapshots: unknown[] = [];

    function snapshot(label: string): void {
      const carrier = nearestCarrier(sim);

      snapshots.push({
        atEarth: sim.atEarth,
        collected: sim.stars.map((star) => star.collected),
        collectedCount: sim.collectedCount,
        deaths: sim.deaths,
        events: sim.events.map((event) =>
          event.kind === "logged"
            ? { kind: event.kind, starIndex: event.starIndex }
            : { kind: event.kind },
        ),
        label,
        nearestCarrier: carrier
          ? {
              bearing: carrier.bearing,
              distance: carrier.distance,
              starIndex: carrier.starIndex,
              strength: carrier.strength,
            }
          : null,
        orbitFresh: sim.orbitFresh,
        orbitIndex: sim.orbitIndex,
        phase: sim.phase,
        radarBlips: radarBlips(sim),
        ship: {
          boosting: sim.ship.boosting,
          fuel: sim.ship.fuel,
          heading: sim.ship.heading,
          speed: sim.ship.speed,
          vx: sim.ship.vx,
          vy: sim.ship.vy,
          x: sim.ship.x,
          y: sim.ship.y,
        },
        time: sim.time,
      });
    }

    function step(frames: number, input = { boost: false, steer: 0 }): void {
      for (let index = 0; index < frames; index++) {
        stepSim(sim, input, simFixture.step);
      }
    }

    snapshot("boot");
    step(60);
    snapshot("cruise-1s");
    step(30, { boost: true, steer: 1 });
    snapshot("boost-turn-0.5s");
    sim.ship.x = sim.stars[0].x;
    sim.ship.y = sim.stars[0].y;
    sim.ship.fuel = 20;
    stepSim(sim, { boost: false, steer: 0 }, simFixture.step);
    snapshot("orbit-first-star");
    drainEvents(sim);
    step(120);
    snapshot("orbit-refuel-2s");
    departOrbit(sim);
    snapshot("depart-first-star");
    resetSim(sim, false);
    snapshot("reset");

    expectSnapshotArray(snapshots, simFixture.snapshots);
  });
});

describe("SSH frontier contacts parity fixture", () => {
  it("matches TypeScript frontier placement and scope contacts", () => {
    const stars = placeStars(frontierFixture.tracks);
    const entities = placeFrontier(stars, frontierFixture.frontier, frontierFixture.seed);
    const sim = createSim(stars, {
      frontier: frontierFixture.frontier,
      seed: frontierFixture.seed,
    });
    const snapshots: unknown[] = [];

    expectFixtureValue(entities, frontierFixture.entities, "frontier.entities");

    function snapshot(label: string): void {
      snapshots.push({
        contacts: scopeContacts(sim),
        events: drainEvents(sim).map((event) =>
          event.kind === "logged"
            ? { kind: event.kind, starIndex: event.starIndex }
            : { kind: event.kind },
        ),
        label,
        ship: {
          fuel: sim.ship.fuel,
          heading: sim.ship.heading,
          speed: sim.ship.speed,
          vx: sim.ship.vx,
          vy: sim.ship.vy,
          x: sim.ship.x,
          y: sim.ship.y,
        },
      });
    }

    const blackhole = sim.entities.find((entity) => entity.kind === "blackhole");
    const asteroid = sim.entities.find((entity) => entity.kind === "asteroid");

    snapshot("boot");

    expect(blackhole).toBeDefined();
    expect(asteroid).toBeDefined();

    if (!blackhole || !asteroid) {
      return;
    }

    sim.ship.x = blackhole.x - 120;
    sim.ship.y = blackhole.y;
    sim.ship.heading = 0;
    snapshot("near-blackhole");
    stepSim(sim, { boost: false, steer: 0 }, 1 / 60);
    snapshot("blackhole-pull");
    sim.ship.x = blackhole.x;
    sim.ship.y = blackhole.y;
    stepSim(sim, { boost: false, steer: 0 }, 1 / 60);
    snapshot("blackhole-warp");
    sim.ship.x = asteroid.x - 100;
    sim.ship.y = asteroid.y;
    sim.ship.heading = 0;
    snapshot("near-asteroid");

    expectSnapshotArray(snapshots, frontierFixture.snapshots);
  });
});

function expectSnapshotArray(actual: unknown[], expected: unknown[]): void {
  expect(actual).toHaveLength(expected.length);

  for (let index = 0; index < actual.length; index++) {
    expectFixtureValue(actual[index], expected[index], `snapshots[${index}]`);
  }
}

function expectFixtureValue(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === "number") {
    expect(typeof actual, path).toBe("number");
    expect(actual as number, path).toBeCloseTo(expected, 12);
    return;
  }

  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect(actual as unknown[], path).toHaveLength(expected.length);

    for (let index = 0; index < expected.length; index++) {
      expectFixtureValue((actual as unknown[])[index], expected[index], `${path}[${index}]`);
    }
    return;
  }

  if (expected && typeof expected === "object") {
    expect(actual && typeof actual === "object", path).toBe(true);
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;

    expect(
      Object.keys(actualRecord)
        .filter((key) => actualRecord[key] !== undefined)
        .sort(),
      path,
    ).toEqual(Object.keys(expectedRecord).sort());

    for (const key of Object.keys(expectedRecord)) {
      expectFixtureValue(actualRecord[key], expectedRecord[key], `${path}.${key}`);
    }
    return;
  }

  expect(actual, path).toEqual(expected);
}
