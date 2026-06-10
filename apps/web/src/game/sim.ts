import { frontierRadius } from "./placement";
import { type Star } from "./types";

// The flight sim (docs/galaxy-game.md, "Confirmed decisions"). Fixed-timestep,
// pure state-in/state-out — no canvas, no audio, no DOM — so the loop is
// testable and the renderer/audio read from it without back-pressure.
//
// The stakes contract: fuel always burns (boost gulps), refuel only at Earth
// or at a star during the visit in which it was logged (the listening moment
// doubles as the pump), run dry and you drift, get towed home, start at 0/N.

/** How fast the ship turns, radians/second. */
const TURN_RATE = 1.9;
/** Acceleration ease toward the target speed, 1/seconds. */
const ACCEL = 2.2;
const CRUISE_SPEED = 70;
const BOOST_SPEED = 170;
/** Drift speed while eased into a star's orbit (the listening moment). */
const ORBIT_SPEED = 16;
const TANK_CAPACITY = 100;
/** Full tank from dry in ~12s of orbit — most of a preview's chorus. */
const REFUEL_RATE = 8.5;
/** Boost trades fuel for time: ~2.4x speed for 3.5x burn. */
const BOOST_BURN_FACTOR = 3.5;
/** One tank at cruise covers the frontier with this much slack. */
const RANGE_FACTOR = 1.8;
const MIN_RANGE = 3600;
const STAR_ORBIT_RADIUS = 64;
const EARTH_ORBIT_RADIUS = 110;
/** Seconds adrift (dead stick, dimming instruments) before the tow home. */
const ADRIFT_SECONDS = 4;
const LOW_FUEL_FRACTION = 0.25;

export type SimConfig = {
  audioRange: number;
  boostBurn: number;
  cruiseBurn: number;
  earthOrbitRadius: number;
  radarRange: number;
  refuelRate: number;
  starOrbitRadius: number;
  tankCapacity: number;
};

export type SimPhase = "adrift" | "flying" | "home" | "orbiting";

/** One-shot happenings for the audio/telemetry layers to consume. */
export type SimEvent =
  | { kind: "adrift" }
  | { kind: "all-found" }
  | { kind: "home" }
  | { kind: "logged"; starIndex: number }
  | { kind: "low-fuel" }
  | { kind: "refuelled" }
  | { kind: "towed" };

export type ShipState = {
  boosting: boolean;
  fuel: number;
  heading: number;
  speed: number;
  x: number;
  y: number;
};

export type SimState = {
  adriftT: number;
  atEarth: boolean;
  collected: boolean[];
  collectedCount: number;
  config: SimConfig;
  deaths: number;
  events: SimEvent[];
  lowFuelWarned: boolean;
  /** Index of the star whose orbit the ship is inside, or -1. */
  orbitIndex: number;
  /** True while still in the orbit of the star logged on this visit. */
  orbitFresh: boolean;
  phase: SimPhase;
  ship: ShipState;
  stars: Star[];
  time: number;
};

export type SimInput = {
  boost: boolean;
  /** -1 (port) .. 1 (starboard). */
  steer: number;
};

// The ship Fluncle lends you is fit for the current frontier: burn rates are
// tuned at boot so one tank at cruise reaches the newest finding with slack.
// When the frontier outgrows what one tank should cover, the answer is new
// home planets out there, not a bigger tank (docs/galaxy-game.md).
export function tuneConfig(stars: Star[]): SimConfig {
  const range = Math.max(MIN_RANGE, frontierRadius(stars) * RANGE_FACTOR);
  const cruiseBurn = (CRUISE_SPEED * TANK_CAPACITY) / range;

  return {
    audioRange: 680,
    boostBurn: cruiseBurn * BOOST_BURN_FACTOR,
    cruiseBurn,
    earthOrbitRadius: EARTH_ORBIT_RADIUS,
    radarRange: 1320,
    refuelRate: REFUEL_RATE,
    starOrbitRadius: STAR_ORBIT_RADIUS,
    tankCapacity: TANK_CAPACITY,
  };
}

export function createSim(stars: Star[]): SimState {
  const config = tuneConfig(stars);

  return {
    adriftT: 0,
    atEarth: false,
    collected: stars.map(() => false),
    collectedCount: 0,
    config,
    deaths: 0,
    events: [],
    lowFuelWarned: false,
    orbitFresh: false,
    orbitIndex: -1,
    phase: "flying",
    ship: launchShip(config),
    stars,
    time: 0,
  };
}

/** Fresh ship on the pad: just clear of Earth orbit, pointed at the stars. */
function launchShip(config: SimConfig): ShipState {
  // Heading -PI/2 flies toward -y, so the pad sits at -y too: Earth at your
  // back (a bottom-of-scope radar blip), open galaxy ahead.
  return {
    boosting: false,
    fuel: TANK_CAPACITY,
    heading: -Math.PI / 2,
    speed: CRUISE_SPEED,
    x: 0,
    y: -(config.earthOrbitRadius + 30),
  };
}

/** Restart after a tow (or a manual restart): same galaxy, 0/N, full tank. */
export function resetSim(state: SimState, countDeath: boolean): void {
  state.adriftT = 0;
  state.atEarth = false;
  state.collected = state.stars.map(() => false);
  state.collectedCount = 0;
  state.deaths += countDeath ? 1 : 0;
  state.lowFuelWarned = false;
  state.orbitFresh = false;
  state.orbitIndex = -1;
  state.phase = "flying";
  state.ship = launchShip(state.config);
}

export function stepSim(state: SimState, input: SimInput, dt: number): void {
  state.time += dt;

  const { ship } = state;

  if (state.phase === "adrift") {
    ship.speed = ease(ship.speed, 0, dt * 0.9);
    ship.x += Math.cos(ship.heading) * ship.speed * dt;
    ship.y += Math.sin(ship.heading) * ship.speed * dt;
    state.adriftT += dt;

    if (state.adriftT >= ADRIFT_SECONDS) {
      state.events.push({ kind: "towed" });
      resetSim(state, true);
    }

    return;
  }

  if (state.phase === "home") {
    ship.speed = ease(ship.speed, 0, dt * 1.4);

    return;
  }

  // Parked on a banger: the listening moment. Time passes, nothing burns;
  // a freshly logged star pumps the tank while the preview loops. The only
  // way out is departOrbit() — any key, any tap.
  if (state.phase === "orbiting") {
    ship.speed = 0;
    ship.boosting = false;

    if (state.orbitFresh) {
      const wasFull = ship.fuel >= state.config.tankCapacity;

      ship.fuel = Math.min(state.config.tankCapacity, ship.fuel + state.config.refuelRate * dt);

      if (!wasFull && ship.fuel >= state.config.tankCapacity) {
        state.events.push({ kind: "refuelled" });
      }

      if (ship.fuel > state.config.tankCapacity * 0.5) {
        state.lowFuelWarned = false;
      }
    }

    return;
  }

  // Steering and speed. Boost only answers while there's fuel to gulp.
  const boosting = input.boost && ship.fuel > 0;

  ship.boosting = boosting;
  ship.heading += input.steer * TURN_RATE * (boosting ? 0.75 : 1) * dt;

  const inOrbit = state.orbitIndex >= 0 || state.atEarth;
  const targetSpeed = boosting ? BOOST_SPEED : inOrbit ? ORBIT_SPEED : CRUISE_SPEED;

  ship.speed = ease(ship.speed, targetSpeed, dt * ACCEL);
  ship.x += Math.cos(ship.heading) * ship.speed * dt;
  ship.y += Math.sin(ship.heading) * ship.speed * dt;

  updateOrbit(state);
  updateFuel(state, boosting, dt);
  updateWin(state);
}

function updateOrbit(state: SimState): void {
  const { config, ship } = state;

  state.atEarth = Math.hypot(ship.x, ship.y) <= config.earthOrbitRadius;

  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < state.stars.length; index++) {
    const star = state.stars[index];
    const distance = Math.hypot(star.x - ship.x, star.y - ship.y);

    if (distance <= config.starOrbitRadius && distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  if (nearestIndex < 0) {
    return;
  }

  // Reaching any star parks the ship: fresh ones get logged and pump fuel,
  // logged ones replay. Flying resumes via departOrbit().
  state.orbitIndex = nearestIndex;
  state.orbitFresh = false;
  state.phase = "orbiting";

  if (!state.collected[nearestIndex]) {
    state.collected[nearestIndex] = true;
    state.collectedCount += 1;
    state.orbitFresh = true;
    state.events.push({ kind: "logged", starIndex: nearestIndex });

    if (state.collectedCount === state.stars.length) {
      state.events.push({ kind: "all-found" });
    }
  }
}

/** Leave the listening moment: nose pointed away from the star, cruise on. */
export function departOrbit(state: SimState): void {
  if (state.phase !== "orbiting" || state.orbitIndex < 0) {
    return;
  }

  const star = state.stars[state.orbitIndex];
  const { config, ship } = state;
  const away = Math.atan2(ship.y - star.y, ship.x - star.x);
  const heading =
    Number.isFinite(away) && Math.hypot(ship.x - star.x, ship.y - star.y) > 1
      ? away
      : ship.heading + Math.PI;

  ship.heading = heading;
  ship.x = star.x + Math.cos(heading) * (config.starOrbitRadius + 24);
  ship.y = star.y + Math.sin(heading) * (config.starOrbitRadius + 24);
  ship.speed = CRUISE_SPEED;
  state.orbitFresh = false;
  state.orbitIndex = -1;
  state.phase = "flying";
}

function updateFuel(state: SimState, boosting: boolean, dt: number): void {
  const { config, ship } = state;
  // Star refuelling happens in the orbiting branch; in flight only Earth
  // (home always tops you up) counts.
  const refueling = state.atEarth;

  if (refueling) {
    const wasFull = ship.fuel >= config.tankCapacity;

    ship.fuel = Math.min(config.tankCapacity, ship.fuel + config.refuelRate * dt);

    if (!wasFull && ship.fuel >= config.tankCapacity) {
      state.events.push({ kind: "refuelled" });
    }

    if (ship.fuel > config.tankCapacity * 0.5) {
      state.lowFuelWarned = false;
    }

    return;
  }

  ship.fuel -= (boosting ? config.boostBurn : config.cruiseBurn) * dt;

  if (ship.fuel <= config.tankCapacity * LOW_FUEL_FRACTION && !state.lowFuelWarned) {
    state.lowFuelWarned = true;
    state.events.push({ kind: "low-fuel" });
  }

  if (ship.fuel <= 0) {
    ship.fuel = 0;
    state.adriftT = 0;
    state.phase = "adrift";
    state.events.push({ kind: "adrift" });
  }
}

function updateWin(state: SimState): void {
  if (state.phase === "flying" && state.atEarth && state.collectedCount === state.stars.length) {
    state.phase = "home";
    state.events.push({ kind: "home" });
  }
}

/** Drain one-shot events; the caller (game loop) fans them out. */
export function drainEvents(state: SimState): SimEvent[] {
  const events = state.events;

  state.events = [];

  return events;
}

/** Relative bearing from the ship's nose to a world point, [-PI, PI]. */
export function bearingTo(ship: ShipState, x: number, y: number): number {
  const absolute = Math.atan2(y - ship.y, x - ship.x);

  return wrapAngle(absolute - ship.heading);
}

export function wrapAngle(angle: number): number {
  let wrapped = angle % (Math.PI * 2);

  if (wrapped > Math.PI) {
    wrapped -= Math.PI * 2;
  }

  if (wrapped < -Math.PI) {
    wrapped += Math.PI * 2;
  }

  return wrapped;
}

export type CarrierInfo = {
  bearing: number;
  distance: number;
  starIndex: number;
  /** 0 (out of range) .. 1 (on top of it). */
  strength: number;
};

/** The nearest uncollected star — the carrier the radar and audio chase. */
export function nearestCarrier(state: SimState): CarrierInfo | undefined {
  const { config, ship } = state;
  let best: CarrierInfo | undefined;

  for (let index = 0; index < state.stars.length; index++) {
    if (state.collected[index]) {
      continue;
    }

    const star = state.stars[index];
    const distance = Math.hypot(star.x - ship.x, star.y - ship.y);

    if (!best || distance < best.distance) {
      best = {
        bearing: bearingTo(ship, star.x, star.y),
        distance,
        starIndex: index,
        strength: Math.max(0, 1 - distance / config.audioRange),
      };
    }
  }

  return best;
}

export type RadarBlip = {
  bearing: number;
  distance: number;
  kind: "earth" | "star";
  starIndex: number;
};

// Every uncollected star in radar range — multi-blip on purpose, so route
// choice is a real decision. Earth joins the scope when it's in range, and
// becomes the only blip once the galaxy is logged (the final carrier home).
export function radarBlips(state: SimState): RadarBlip[] {
  const { config, ship } = state;
  const blips: RadarBlip[] = [];
  const done = state.collectedCount === state.stars.length;

  if (!done) {
    for (let index = 0; index < state.stars.length; index++) {
      if (state.collected[index]) {
        continue;
      }

      const star = state.stars[index];
      const distance = Math.hypot(star.x - ship.x, star.y - ship.y);

      if (distance <= config.radarRange) {
        blips.push({
          bearing: bearingTo(ship, star.x, star.y),
          distance,
          kind: "star",
          starIndex: index,
        });
      }
    }
  }

  const earthDistance = Math.hypot(ship.x, ship.y);

  if (done || earthDistance <= config.radarRange) {
    blips.push({
      bearing: bearingTo(ship, 0, 0),
      distance: Math.min(earthDistance, config.radarRange),
      kind: "earth",
      starIndex: -1,
    });
  }

  return blips;
}

function ease(current: number, target: number, t: number): number {
  return current + (target - current) * Math.min(1, t);
}
