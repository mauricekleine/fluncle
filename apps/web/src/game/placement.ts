import { FINDING_LOG_ID_PATTERN } from "@fluncle/contracts/log-id";
import { type FrontierEntity, type GameTrack, type Star, type Vec2 } from "./types";
import { fnv1a, sectorDay } from "../lib/log-id-shared";

export { fnv1a };

export const CLEAR_SPACE = 620;

export const SECTORS_PER_TURN = 9;

export const ARM_GAP = 560;

const ANGLE_PER_SECTOR = (Math.PI * 2) / SECTORS_PER_TURN;

const SPIRAL_PITCH = ARM_GAP / (Math.PI * 2);

const MIN_ARC_SPACING = 700;

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(track: GameTrack): string {
  return track.logId ?? track.trackId;
}

function sectorOf(track: GameTrack): number {
  const logId = track.logId;

  if (logId && FINDING_LOG_ID_PATTERN.test(logId)) {
    return Number.parseInt(logId, 10);
  }

  return sectorDay(track.addedAt);
}

export function spiralRadius(theta: number): number {
  return CLEAR_SPACE + SPIRAL_PITCH * theta;
}

export function spiralPoint(theta: number): Vec2 {
  const radius = spiralRadius(theta);

  return { x: Math.cos(theta) * radius, y: Math.sin(theta) * radius };
}

export function spiralAngleAt(radius: number): number {
  return (radius - CLEAR_SPACE) / SPIRAL_PITCH;
}

function intraDayOrder(a: GameTrack, b: GameTrack): number {
  const ha = fnv1a(seedOf(a));
  const hb = fnv1a(seedOf(b));

  if (ha !== hb) {
    return ha - hb;
  }

  const sa = seedOf(a);
  const sb = seedOf(b);

  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function placeStars(tracks: GameTrack[]): Star[] {
  if (tracks.length === 0) {
    return [];
  }

  const bySector = new Map<number, GameTrack[]>();

  for (const track of tracks) {
    const sector = sectorOf(track);
    const group = bySector.get(sector) ?? [];

    group.push(track);
    bySector.set(sector, group);
  }

  const sectors = [...bySector.keys()].sort((a, b) => a - b);
  const firstSector = sectors[0] ?? 0;
  const stars: Star[] = [];

  let thetaRunning = 0;

  for (const sector of sectors) {
    const group = (bySector.get(sector) ?? []).slice().sort(intraDayOrder);
    const thetaNominal = (sector - firstSector) * ANGLE_PER_SECTOR;
    let theta = Math.max(thetaNominal, thetaRunning);

    for (const track of group) {
      const seed = seedOf(track);
      const radius = spiralRadius(theta);

      const point = spiralPoint(theta);

      stars.push({
        angle: theta,
        artistLine: track.artists.join(", "),
        collected: false,
        id: track.logId ?? seed,
        kind: "star",
        logId: track.logId ?? seed,
        radius,
        sector,
        spotifyUrl: track.spotifyUrl,
        title: track.title,
        trackId: track.trackId,
        vOffset: (fnv1a(`${seed}#v`) % 440) - 220,
        vx: 0,
        vy: 0,
        x: point.x,
        y: point.y,
      });

      theta += MIN_ARC_SPACING / radius;
    }

    thetaRunning = theta;
  }

  return stars;
}

export function frontierRadius(stars: Star[]): number {
  return stars.reduce((max, star) => Math.max(max, star.radius), CLEAR_SPACE);
}

export type FrontierConfig = {
  asteroids?: boolean;

  blackHoles?: boolean;

  setDressing?: boolean;
};

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

const FRONTIER_INNER = 900;

const FRONTIER_ARC = 1;

function frontierAngle(radius: number, key: string): number {
  const jitter = ((fnv1a(key) / 0xffffffff) * 2 - 1) * FRONTIER_ARC;

  return spiralAngleAt(radius) + Math.PI + jitter;
}

function placeSetDressing(stars: Star[]): FrontierEntity[] {
  const frontier = frontierRadius(stars);

  if (frontier <= FRONTIER_INNER) {
    return [];
  }

  const span = frontier - FRONTIER_INNER;
  const entities: FrontierEntity[] = [];

  entities.push(makeDressing("roadster", "roadster", FRONTIER_INNER + span * 0.45, 30));

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
  const angle = frontierAngle(radius, seedKey);

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

const SLOTS_PER_SYSTEM = 5;

const STARS_PER_BLACKHOLE = 50;

const MIN_STARS_FOR_BLACKHOLE = 12;

const BLACKHOLE_HORIZON = 34;

const BLACKHOLE_MIN_STAR_GAP = 220;

function tooCloseToStar(x: number, y: number, stars: Star[], gap: number): boolean {
  return stars.some((star) => Math.hypot(star.x - x, star.y - y) < gap);
}

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

    for (let attempt = 0; attempt < 200 && slots.length < SLOTS_PER_SYSTEM; attempt++) {
      const key = `blackhole:${system}:${attempt}`;
      const reach = (fnv1a(`${key}#r`) % 1000) / 1000;
      const radius = FRONTIER_INNER + span * (0.3 + 0.7 * reach);
      const angle = frontierAngle(radius, key);
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

    if (live === undefined) {
      continue;
    }

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

const ASTEROID_INNER = 1100;

export function placeAsteroids(stars: Star[]): FrontierEntity[] {
  const frontier = frontierRadius(stars);

  if (frontier <= ASTEROID_INNER) {
    return [];
  }

  const span = frontier - ASTEROID_INNER;
  const waves = Math.min(5, 1 + Math.floor(span / 1600));
  const entities: FrontierEntity[] = [];

  for (let wave = 0; wave < waves; wave++) {
    const baseRadius = ASTEROID_INNER + (span * (wave + 1)) / (waves + 1);
    const baseAngle = frontierAngle(baseRadius, `asteroid:${wave}`);
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
