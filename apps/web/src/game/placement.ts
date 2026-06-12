import { type FrontierEntity, type GameTrack, type Star, type Vec2 } from "./types";

// Deterministic star placement from the Log ID (docs/ROADMAP.md, "The
// expanding frontier"). The sector (days since the Fluncle epoch) maps to
// radial distance from Earth — the oldest findings orbit close to home and
// every new finding pushes the frontier outward, deliberately uncompressed.
// The hash tail spreads same-day findings around their shared orbital ring.
// Pure function of the catalogue, so every run is the same galaxy: map
// knowledge carrying across deaths is the skill curve.

/** Mirrors the server's Fluncle epoch (apps/web/src/lib/server/log-id.ts). */
const EPOCH_MS = Date.UTC(2026, 4, 30);
const DAY_MS = 86_400_000;

/** Clear space around Earth before the first ring. */
const FIRST_RING_RADIUS = 620;
/** Radial gap between consecutive sectors. */
const RING_GAP = 240;
/** Minimum arc distance between same-ring stars (keeps orbits + audio apart). */
const MIN_ARC_SPACING = 700;

const LOG_ID_PATTERN = /^(\d+)\.\d\.\d[A-Z]$/;

/** Stable 32-bit FNV-1a hash, same as the server's Log ID tail. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

// A tiny seeded PRNG (mulberry32). The galaxy's POSITIONS stay deterministic
// off fnv1a (every run is the same map), but a few frontier choices — which of
// a black hole's candidate slots is live this run — want per-run variety
// without going truly random (which would break determinism and the tests).
// A boot-time session seed threads through placement so stepSim stays pure and
// the tests pin a fixed seed.
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sectorOf(track: GameTrack): number {
  const match = track.logId?.match(LOG_ID_PATTERN);

  if (match) {
    return Number.parseInt(match[1], 10);
  }

  // Stragglers without a coordinate (pre-Log-ID rows) derive their sector the
  // same way the server would have: days since the epoch, from the found date.
  const found = new Date(track.addedAt).getTime();

  return Number.isNaN(found) ? 0 : Math.max(0, Math.floor((found - EPOCH_MS) / DAY_MS));
}

function ringRadius(sector: number): number {
  return FIRST_RING_RADIUS + sector * RING_GAP;
}

/** Place every finding in the field. Deterministic for a given catalogue. */
export function placeStars(tracks: GameTrack[]): Star[] {
  const rings = new Map<number, Array<{ angle: number; track: GameTrack }>>();

  for (const track of tracks) {
    const sector = sectorOf(track);
    const seed = track.logId ?? track.trackId;
    const angle = (fnv1a(seed) / 0xffffffff) * Math.PI * 2;
    const ring = rings.get(sector) ?? [];

    ring.push({ angle, track });
    rings.set(sector, ring);
  }

  const stars: Star[] = [];

  for (const [sector, ring] of [...rings.entries()].sort(([a], [b]) => a - b)) {
    const radius = ringRadius(sector);

    for (const placed of spreadRing(ring, radius)) {
      const seed = placed.track.logId ?? placed.track.trackId;

      stars.push({
        angle: placed.angle,
        artistLine: placed.track.artists.join(", "),
        collected: false,
        id: placed.track.logId ?? seed,
        kind: "star",
        logId: placed.track.logId ?? seed,
        radius,
        sector,
        spotifyUrl: placed.track.spotifyUrl,
        title: placed.track.title,
        trackId: placed.track.trackId,
        vOffset: (fnv1a(`${seed}#v`) % 440) - 220,
        vx: 0,
        vy: 0,
        x: Math.cos(placed.angle) * radius,
        y: Math.sin(placed.angle) * radius,
      });
    }
  }

  return stars;
}

// Same-day findings share a ring; keep their hash-given angles but walk the
// ring and push neighbours apart until every arc gap clears MIN_ARC_SPACING.
// Sorted by Log ID first so the nudge is deterministic for a given catalogue.
function spreadRing(
  ring: Array<{ angle: number; track: GameTrack }>,
  radius: number,
): Array<{ angle: number; track: GameTrack }> {
  if (ring.length < 2) {
    return ring;
  }

  const minGap = Math.min(MIN_ARC_SPACING / radius, (Math.PI * 2) / ring.length);
  const sorted = [...ring].sort((a, b) =>
    (a.track.logId ?? a.track.trackId).localeCompare(b.track.logId ?? b.track.trackId),
  );

  sorted.sort((a, b) => a.angle - b.angle);

  for (let pass = 0; pass < 8; pass++) {
    let moved = false;

    for (let index = 0; index < sorted.length; index++) {
      const current = sorted[index];
      const next = sorted[(index + 1) % sorted.length];
      const gap =
        index + 1 === sorted.length
          ? next.angle + Math.PI * 2 - current.angle
          : next.angle - current.angle;

      if (gap < minGap) {
        const push = (minGap - gap) / 2;

        current.angle -= push;
        next.angle += push;
        moved = true;
      }
    }

    if (!moved) {
      break;
    }
  }

  return sorted;
}

/** The current frontier: how far out the newest finding sits. */
export function frontierRadius(stars: Star[]): number {
  return stars.reduce((max, star) => Math.max(max, star.radius), ringRadius(0));
}

// What the frontier should contain this run. Grows per content unit; each flag
// is off unless the game turns it on. The economy fields ride sane defaults
// (Maurice's playthrough tunes them; out of agent scope per the RFC).
export type FrontierConfig = {
  /** Asteroid waves + the auto-clearing laser (Unit D); flag-gated off. */
  asteroids?: boolean;
  /** Black-hole teleport network (Unit C). */
  blackHoles?: boolean;
  /** Roadster + UFO set-dressing (Unit B). */
  setDressing?: boolean;
};

// Deterministically seed the dynamic frontier from the placed stars. POSITIONS
// are a pure function of the catalogue (same galaxy every run); only a few
// choices use the session `seed` for run-to-run variety (see makeRng). Called
// at boot and again on a tow, so a restart rebuilds the identical frontier.
// Content units (B set-dressing, C black holes, D asteroids) append their
// entities here, each gated by its config flag.
export function placeFrontier(
  stars: Star[],
  config: FrontierConfig,
  seed: number,
): FrontierEntity[] {
  const entities: FrontierEntity[] = [];

  if (config.setDressing) {
    entities.push(...placeSetDressing(stars));
  }

  if (config.blackHoles) {
    entities.push(...placeBlackHoles(stars, seed));
  }

  if (config.asteroids) {
    entities.push(...placeAsteroids(stars));
  }

  return entities;
}

/** Inner edge of the strange: near space (the warm early catalogue) stays quiet. */
const FRONTIER_INNER = 900;

// Render-only set-dressing (Unit B): a derelict Roadster and a few UFOs in the
// empty stretches, more frequent the farther out you are ("the further out,
// the stranger"). Fully deterministic off fnv1a — same wink in the same place
// every run. Velocity stays 0; their drift + tumble is render-cosmetic so the
// renderer can freeze it under reduced-motion without touching the sim. They
// live in the frontier array, never the star list, so they can never read as a
// carrier or a radar blip.
function placeSetDressing(stars: Star[]): FrontierEntity[] {
  const frontier = frontierRadius(stars);

  if (frontier <= FRONTIER_INNER) {
    return [];
  }

  const span = frontier - FRONTIER_INNER;
  const entities: FrontierEntity[] = [];

  // The Roadster: one canonical space-junk wink, mid-to-far.
  entities.push(makeDressing("roadster", "roadster", FRONTIER_INNER + span * 0.45, 30));

  // UFOs scale with how far the frontier has pushed; each sits farther than the
  // last, biased to the strange outer reaches.
  const ufoCount = Math.min(6, Math.floor(span / 1400));

  for (let index = 0; index < ufoCount; index++) {
    const fraction = (index + 1) / (ufoCount + 1);

    entities.push(
      makeDressing("ufo", `ufo:${index}`, FRONTIER_INNER + span * (0.5 + 0.5 * fraction), 26),
    );
  }

  return entities;
}

function makeDressing(
  kind: "roadster" | "ufo",
  seedKey: string,
  radius: number,
  bodyRadius: number,
): FrontierEntity {
  const angle = (fnv1a(seedKey) / 0xffffffff) * Math.PI * 2;

  return {
    bodyRadius,
    id: `${kind}:${seedKey}`,
    kind,
    radius,
    spin: (fnv1a(`${seedKey}#spin`) % 628) / 100,
    vOffset: (fnv1a(`${seedKey}#v`) % 360) - 180,
    vx: 0,
    vy: 0,
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

/** Slots per black-hole system: one goes live, the other four are its exits. */
const SLOTS_PER_SYSTEM = 5;
/** One system per this many findings (economy default; Maurice's playthrough tunes). */
const STARS_PER_BLACKHOLE = 50;
/** Enough findings for a frontier worth the danger — a system shows before 50. */
const MIN_STARS_FOR_BLACKHOLE = 12;
/** Event-horizon radius (crossing it warps you); also the visual body size. */
const BLACKHOLE_HORIZON = 34;
/** Keep holes off the bangers so a slot never sits on the route to a star. */
const BLACKHOLE_MIN_STAR_GAP = 220;

function tooCloseToStar(x: number, y: number, stars: Star[], gap: number): boolean {
  return stars.some((star) => Math.hypot(star.x - x, star.y - y) < gap);
}

// The black-hole teleport network (Unit C). One system per ~50 findings (at
// least one once the frontier is real). Each system has 5 DETERMINISTIC
// candidate slots in the empty far stretches, kept off the bangers; the session
// `seed` picks which slot is live this run and which four become its exits.
// Crossing the live hole's horizon flings you to one of its exits (sim.ts) —
// deterministic map you can learn, with run-to-run variety in which slot bites.
export function placeBlackHoles(stars: Star[], seed: number): FrontierEntity[] {
  if (stars.length < MIN_STARS_FOR_BLACKHOLE) {
    return [];
  }

  const systems = Math.max(1, Math.floor(stars.length / STARS_PER_BLACKHOLE));
  const frontier = frontierRadius(stars);

  if (frontier <= FRONTIER_INNER) {
    return [];
  }

  const span = frontier - FRONTIER_INNER;
  const rng = makeRng(seed ^ 0x5bd1e995);
  const entities: FrontierEntity[] = [];

  for (let system = 0; system < systems; system++) {
    const slots: Vec2[] = [];

    // Walk deterministic candidate positions until five clear the bangers.
    for (let attempt = 0; attempt < 200 && slots.length < SLOTS_PER_SYSTEM; attempt++) {
      const key = `blackhole:${system}:${attempt}`;
      const angle = (fnv1a(key) / 0xffffffff) * Math.PI * 2;
      const reach = (fnv1a(`${key}#r`) % 1000) / 1000;
      const radius = FRONTIER_INNER + span * (0.3 + 0.7 * reach);
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;

      if (!tooCloseToStar(x, y, stars, BLACKHOLE_MIN_STAR_GAP)) {
        slots.push({ x, y });
      }
    }

    if (slots.length < SLOTS_PER_SYSTEM) {
      continue;
    }

    const liveIndex = Math.floor(rng() * slots.length);
    const live = slots[liveIndex];
    const exits = slots.filter((_, index) => index !== liveIndex);

    entities.push({
      bodyRadius: BLACKHOLE_HORIZON,
      exits,
      id: `blackhole:${system}`,
      kind: "blackhole",
      radius: Math.hypot(live.x, live.y),
      vOffset: 0,
      vx: 0,
      vy: 0,
      x: live.x,
      y: live.y,
    });
  }

  return entities;
}

/** Asteroids only in the long far stretches; near space stays clear. */
const ASTEROID_INNER = 1100;

// Asteroid waves (Unit D, flag-gated): clusters drifting in the empty far
// stretches, more waves the farther the frontier has pushed. Positions +
// drift are deterministic off fnv1a (the same galaxy every run; a tow rebuilds
// them). A hull hit costs fuel (sim.ts), never ends the run; the ship's
// auto-clearing laser thins them ahead.
export function placeAsteroids(stars: Star[]): FrontierEntity[] {
  const frontier = frontierRadius(stars);

  if (frontier <= ASTEROID_INNER) {
    return [];
  }

  const span = frontier - ASTEROID_INNER;
  const waves = Math.min(5, 1 + Math.floor(span / 1600));
  const entities: FrontierEntity[] = [];

  for (let wave = 0; wave < waves; wave++) {
    const baseAngle = (fnv1a(`asteroid:${wave}`) / 0xffffffff) * Math.PI * 2;
    const baseRadius = ASTEROID_INNER + (span * (wave + 1)) / (waves + 1);
    const count = 3 + (fnv1a(`asteroid:${wave}#n`) % 4);

    for (let index = 0; index < count; index++) {
      const key = `asteroid:${wave}:${index}`;
      const angle = baseAngle + ((fnv1a(key) % 200) / 1000 - 0.1);
      const radius = baseRadius + ((fnv1a(`${key}#r`) % 400) - 200);
      const driftAngle = (fnv1a(`${key}#d`) / 0xffffffff) * Math.PI * 2;
      const driftSpeed = 6 + (fnv1a(`${key}#s`) % 10);

      entities.push({
        bodyRadius: 12 + (fnv1a(`${key}#b`) % 10),
        id: key,
        kind: "asteroid",
        radius,
        spin: (fnv1a(`${key}#spin`) % 628) / 100,
        vOffset: (fnv1a(`${key}#v`) % 300) - 150,
        vx: Math.cos(driftAngle) * driftSpeed,
        vy: Math.sin(driftAngle) * driftSpeed,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }
  }

  return entities;
}
