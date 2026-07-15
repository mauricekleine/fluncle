import { type FrontierConfig, fnv1a, frontierRadius, placeFrontier } from "./placement";
import { type FrontierEntity, type FrontierKind, type Star } from "./types";

// The flight sim. Fixed-timestep,
// pure state-in/state-out — no canvas, no audio, no DOM — so the loop is
// testable and the renderer/audio read from it without back-pressure.
//
// The stakes contract: fuel always burns (boost gulps), refuel only at Earth
// or at a star during the visit in which it was logged (the listening moment
// doubles as the pump). The dry tank is the one true failure: run dry and you
// drift, get towed home, start at 0/N. Frontier hazards apply pressure but
// never end the run — an asteroid hull-hit costs fuel, a black hole flings you
// elsewhere (with a slingshot top-up); everything routes back through the tank.

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
/** How fast an external push on the ship (black-hole gravity) bleeds off. */
const EXTERNAL_DECAY = 1.6;
/** Default session seed; the game passes a per-run one, tests pin this. */
const DEFAULT_SEED = 0x9e3779b9;
/** Outer reach of a black hole's pull (world units). Economy-tunable. */
const BLACKHOLE_INFLUENCE = 260;
/** Pull acceleration scale near the hole; the dread of being drawn in. */
const BLACKHOLE_PULL = 340;
/** The slingshot: an exit always leaves you with at least this much tank. */
const SLINGSHOT_FUEL_FRACTION = 0.6;
// The auto-clearing laser + asteroids (Unit D, flag-gated). Cosmic path-
// clearing, never a dogfight: the ship thins the rocks dead ahead on its own.
const BOLT_SPEED = 320;
/** Seconds a bolt lives before it's culled. */
const BOLT_TTL = 1.2;
const BOLT_BODY = 4;
/** Seconds between auto-shots. */
const FIRE_COOLDOWN = 0.35;
/** How far ahead the auto-fire reaches for a rock. */
const FIRE_RANGE = 460;
/** Reticle half-angle: a rock within this cone dead ahead gets cleared. */
const FIRE_CONE = 0.22;
const SHIP_HIT_RADIUS = 10;
/** Fuel a hull-hit costs — pressure, not death (the tow stays the only end). */
const ASTEROID_FUEL_COST = 12;

type SimConfig = {
  audioRange: number;
  boostBurn: number;
  cruiseBurn: number;
  earthOrbitRadius: number;
  radarRange: number;
  refuelRate: number;
  starOrbitRadius: number;
  tankCapacity: number;
};

type SimPhase = "adrift" | "flying" | "home" | "orbiting";

/** One-shot happenings for the audio/telemetry layers to consume. */
export type SimEvent =
  | { kind: "adrift" }
  | { kind: "all-found" }
  | { kind: "asteroid-hit" }
  | { kind: "bolt-fired" }
  | { kind: "bolt-hit" }
  | { kind: "home" }
  | { kind: "logged"; starIndex: number }
  | { kind: "low-fuel" }
  | { kind: "refuelled" }
  | { kind: "towed" }
  | { kind: "warped" };

type ShipState = {
  boosting: boolean;
  fuel: number;
  heading: number;
  speed: number;
  /** External velocity (black-hole gravity), bled off each step; 0 in normal flight. */
  vx: number;
  vy: number;
  x: number;
  y: number;
};

export type SimState = {
  adriftT: number;
  atEarth: boolean;
  /** collectedCount at run start — the win needs a HAUL (something logged this run). */
  runStartCollected: number;
  /** Monotonic counter for spawned bolt ids (Unit D). */
  boltSeq: number;
  collectedCount: number;
  config: SimConfig;
  deaths: number;
  /** The dynamic frontier: set-dressing, hazards, and spawned bolts. */
  entities: FrontierEntity[];
  events: SimEvent[];
  /** Seconds until the auto-clearing laser can fire again (Unit D). */
  fireCooldown: number;
  /** Placement inputs, kept so a tow can rebuild the same galaxy. */
  frontier: FrontierConfig;
  lowFuelWarned: boolean;
  /** Index of the star whose orbit the ship is inside, or -1. Stable: the star
   * list never gains or loses members mid-run, so the index is a durable handle. */
  orbitIndex: number;
  /** True while still in the orbit of the star logged on this visit. */
  orbitFresh: boolean;
  phase: SimPhase;
  /** Boot-time session seed; threads into frontier placement (kept pure). */
  seed: number;
  ship: ShipState;
  stars: Star[];
  time: number;
};

export type SimInput = {
  boost: boolean;
  /** Fire the auto-clearing laser (Unit D); flag-gated, off by default. */
  fire?: boolean;
  /** -1 (port) .. 1 (starboard). */
  steer: number;
};

/** Extra per-kind behavior beyond vx/vy drift; collisions live in the step pass. */
export type EntityBehavior = {
  onStep?: (entity: FrontierEntity, state: SimState, dt: number) => void;
};

// The per-kind behavior table. Set-dressing and asteroids drift on vx/vy alone
// and need no entry; the units that add force (black-hole gravity) register
// here. stepEntities iterates once and dispatches.
const BEHAVIORS: Partial<Record<FrontierKind, EntityBehavior>> = {};

export function registerBehavior(kind: FrontierKind, behavior: EntityBehavior): void {
  BEHAVIORS[kind] = behavior;
}

// The ship Fluncle lends you is fit for the current frontier: burn rates are
// tuned at boot so one tank at cruise reaches the newest finding with slack.
// When the frontier outgrows what one tank should cover, the answer is new
// home planets out there, not a bigger tank.
function tuneConfig(stars: Star[]): SimConfig {
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

export type SimOptions = {
  frontier?: FrontierConfig;
  /** Per-run seed for the session-random frontier choices; tests pin it. */
  seed?: number;
};

export function createSim(stars: Star[], options: SimOptions = {}): SimState {
  const config = tuneConfig(stars);
  const frontier = options.frontier ?? {};
  const seed = options.seed ?? DEFAULT_SEED;
  // Lifetime-logged stars arrive already collected (logged IS collected), so the
  // counter opens at the log's size — "2/60", growing toward the whole field.
  const alreadyCollected = stars.filter((star) => star.collected).length;

  return {
    adriftT: 0,
    atEarth: false,
    boltSeq: 0,
    collectedCount: alreadyCollected,
    config,
    deaths: 0,
    entities: placeFrontier(stars, frontier, seed),
    events: [],
    fireCooldown: 0,
    frontier,
    lowFuelWarned: false,
    orbitFresh: false,
    orbitIndex: -1,
    phase: "flying",
    runStartCollected: alreadyCollected,
    seed,
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
    vx: 0,
    vy: 0,
    x: 0,
    y: -(config.earthOrbitRadius + 30),
  };
}

/** Restart after a tow (or a manual restart): same galaxy, the log endures, full tank. */
export function resetSim(state: SimState, countDeath: boolean): void {
  state.adriftT = 0;
  state.atEarth = false;

  // The log survives the tow: every star reached (this run or any before it)
  // stays collected. Nobody re-collects; the universe grows instead.
  for (const star of state.stars) {
    star.collected = star.lifetimeLogged === true;
  }

  state.collectedCount = state.stars.filter((star) => star.collected).length;
  state.runStartCollected = state.collectedCount;

  state.deaths += countDeath ? 1 : 0;
  // Same galaxy, same seed: the frontier rebuilds identically (bolts clear).
  state.entities = placeFrontier(state.stars, state.frontier, state.seed);
  state.fireCooldown = 0;
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
  // The thrust vector plus any external push (black-hole gravity), which then
  // bleeds off. With vx/vy at 0 (normal flight) this is the original motion.
  ship.x += (Math.cos(ship.heading) * ship.speed + ship.vx) * dt;
  ship.y += (Math.sin(ship.heading) * ship.speed + ship.vy) * dt;
  ship.vx = ease(ship.vx, 0, dt * EXTERNAL_DECAY);
  ship.vy = ease(ship.vy, 0, dt * EXTERNAL_DECAY);

  stepEntities(state, dt);

  if (state.frontier.asteroids) {
    stepCombat(state, input, dt);
  }

  updateOrbit(state);
  updateFuel(state, boosting, dt);
  updateWin(state);
}

// Advance the dynamic frontier: drift on vx/vy, dispatch per-kind behavior
// (black-hole gravity), then cull spent bolts. Collisions that mutate the ship
// (hazards) or despawn entities (bolt hits) are handled by the units that own
// them via their behavior + the dedicated passes layered on in those units.
function stepEntities(state: SimState, dt: number): void {
  if (state.entities.length === 0) {
    return;
  }

  for (const entity of state.entities) {
    entity.x += entity.vx * dt;
    entity.y += entity.vy * dt;
    BEHAVIORS[entity.kind]?.onStep?.(entity, state, dt);
  }
}

// The offensive verb (Unit D): auto-fire at a rock in the reticle, then resolve
// bolts → asteroids and asteroids → hull. No score, no kills — the ship clears
// its own path. Bolts only ever hit asteroids; a banger is reached by flying to
// it, never shot. Only runs when the laser flag is on.
function stepCombat(state: SimState, input: SimInput, dt: number): void {
  state.fireCooldown = Math.max(0, state.fireCooldown - dt);
  autoFire(state, input);
  resolveProjectiles(state);
}

function autoFire(state: SimState, input: SimInput): void {
  if (state.fireCooldown > 0) {
    return;
  }

  const { ship } = state;
  let targeted = false;

  for (const entity of state.entities) {
    if (entity.kind !== "asteroid") {
      continue;
    }

    const distance = Math.hypot(entity.x - ship.x, entity.y - ship.y);

    if (distance > FIRE_RANGE) {
      continue;
    }

    if (Math.abs(bearingTo(ship, entity.x, entity.y)) < FIRE_CONE) {
      targeted = true;
      break;
    }
  }

  // Auto-clear a rock in the reticle; the optional F key forces a manual blip.
  if (!targeted && !input.fire) {
    return;
  }

  state.boltSeq += 1;
  state.entities.push({
    bodyRadius: BOLT_BODY,
    id: `bolt:${state.boltSeq}`,
    kind: "bolt",
    radius: Math.hypot(ship.x, ship.y),
    spawnedAt: state.time,
    vOffset: 0,
    vx: Math.cos(ship.heading) * BOLT_SPEED,
    vy: Math.sin(ship.heading) * BOLT_SPEED,
    x: ship.x + Math.cos(ship.heading) * 8,
    y: ship.y + Math.sin(ship.heading) * 8,
  });
  state.fireCooldown = FIRE_COOLDOWN;
  state.events.push({ kind: "bolt-fired" });
}

function resolveProjectiles(state: SimState): void {
  const remove = new Set<FrontierEntity>();
  const asteroids = state.entities.filter((entity) => entity.kind === "asteroid");

  for (const bolt of state.entities) {
    if (bolt.kind !== "bolt") {
      continue;
    }

    if (state.time - (bolt.spawnedAt ?? state.time) > BOLT_TTL) {
      remove.add(bolt);
      continue;
    }

    for (const asteroid of asteroids) {
      if (remove.has(asteroid)) {
        continue;
      }

      const reach = (bolt.bodyRadius ?? BOLT_BODY) + (asteroid.bodyRadius ?? 16);

      if (Math.hypot(bolt.x - asteroid.x, bolt.y - asteroid.y) <= reach) {
        remove.add(bolt);
        remove.add(asteroid);
        state.events.push({ kind: "bolt-hit" });
        break;
      }
    }
  }

  // A hull-hit costs fuel and shatters the rock — pressure, never instant death.
  for (const asteroid of asteroids) {
    if (remove.has(asteroid)) {
      continue;
    }

    const reach = (asteroid.bodyRadius ?? 16) + SHIP_HIT_RADIUS;

    if (Math.hypot(state.ship.x - asteroid.x, state.ship.y - asteroid.y) <= reach) {
      remove.add(asteroid);
      drainFuel(state, ASTEROID_FUEL_COST);
      state.events.push({ kind: "asteroid-hit" });
    }
  }

  if (remove.size > 0) {
    state.entities = state.entities.filter((entity) => !remove.has(entity));
  }
}

function updateOrbit(state: SimState): void {
  const { config, ship } = state;

  state.atEarth = Math.hypot(ship.x, ship.y) <= config.earthOrbitRadius;

  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < state.stars.length; index++) {
    const star = state.stars[index];
    if (star === undefined) {
      continue;
    }
    const distance = Math.hypot(star.x - ship.x, star.y - ship.y);

    if (distance <= config.starOrbitRadius && distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  const nearest = state.stars[nearestIndex];

  if (nearestIndex < 0 || nearest === undefined) {
    return;
  }

  // Reaching any star parks the ship: fresh ones get logged and pump fuel,
  // logged ones replay. Flying resumes via departOrbit().
  state.orbitIndex = nearestIndex;
  state.orbitFresh = false;
  state.phase = "orbiting";

  if (!nearest.collected) {
    nearest.collected = true;
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

  if (star === undefined) {
    return;
  }

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

/** Spend fuel on a hazard glance (asteroid hull-hit); never below empty. */
function drainFuel(state: SimState, amount: number): void {
  state.ship.fuel = Math.max(0, state.ship.fuel - amount);
}

function updateWin(state: SimState): void {
  // A run home needs a HAUL: at least one star logged THIS run. Without the gate,
  // a fully-logged returning player would spawn beside Earth already at 100% and
  // collect a free win on arrival — with it, a complete log simply means nothing
  // left to haul until the universe grows.
  if (
    state.phase === "flying" &&
    state.atEarth &&
    state.collectedCount === state.stars.length &&
    state.collectedCount > state.runStartCollected
  ) {
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
function bearingTo(ship: ShipState, x: number, y: number): number {
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
    const star = state.stars[index];

    if (star === undefined || star.collected) {
      continue;
    }

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

export type ScopeContact = {
  bearing: number;
  bodyRadius: number;
  distance: number;
  id: string;
  influenceRadius?: number;
  kind: "asteroid" | "blackhole";
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
      const star = state.stars[index];

      if (star === undefined || star.collected) {
        continue;
      }

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

export function scopeContacts(state: SimState): ScopeContact[] {
  const { config, ship } = state;
  const contacts: ScopeContact[] = [];

  for (const entity of state.entities) {
    if (entity.kind !== "asteroid" && entity.kind !== "blackhole") {
      continue;
    }

    const distance = Math.hypot(entity.x - ship.x, entity.y - ship.y);

    if (distance > config.radarRange) {
      continue;
    }

    contacts.push({
      bearing: bearingTo(ship, entity.x, entity.y),
      bodyRadius: entity.bodyRadius ?? (entity.kind === "blackhole" ? 34 : 16),
      distance,
      id: entity.id,
      influenceRadius: entity.kind === "blackhole" ? BLACKHOLE_INFLUENCE : undefined,
      kind: entity.kind,
    });
  }

  return contacts;
}

function ease(current: number, target: number, t: number): number {
  return current + (target - current) * Math.min(1, t);
}

// The black hole (Unit C): not a death, a transport. An inverse-ish pull draws
// the ship in within the influence radius (a real force term on ship.vx/vy);
// crossing the event horizon flings you to one of the system's exit slots with
// a slingshot fuel top-up, so the jump is always survivable — scary and
// disorienting (flung into the unknown frontier), never punishing. Map
// knowledge stays the skill: positions are fixed, only which slot bites varies.
registerBehavior("blackhole", {
  onStep: (entity, state, dt) => {
    const { ship } = state;
    const dx = entity.x - ship.x;
    const dy = entity.y - ship.y;
    const distance = Math.max(1e-6, Math.hypot(dx, dy));
    const horizon = entity.bodyRadius ?? 34;

    if (distance <= horizon) {
      warpShip(entity, state);

      return;
    }

    if (distance < BLACKHOLE_INFLUENCE) {
      const falloff = 1 - distance / BLACKHOLE_INFLUENCE;
      const accel = BLACKHOLE_PULL * falloff * falloff;

      ship.vx += (dx / distance) * accel * dt;
      ship.vy += (dy / distance) * accel * dt;
    }
  },
});

function warpShip(entity: FrontierEntity, state: SimState): void {
  const exits = entity.exits ?? [];
  const { ship } = state;

  if (exits.length > 0) {
    // Session-deterministic exit: this hole always flings to the same slot this
    // run (learnable), but the seed varies the pick run to run.
    const exit = exits[fnv1a(`${entity.id}:${state.seed}`) % exits.length];

    if (exit !== undefined) {
      ship.x = exit.x;
      ship.y = exit.y;
    }
  }

  ship.vx = 0;
  ship.vy = 0;
  ship.speed = CRUISE_SPEED;
  ship.fuel = Math.max(ship.fuel, state.config.tankCapacity * SLINGSHOT_FUEL_FRACTION);
  state.events.push({ kind: "warped" });
}
