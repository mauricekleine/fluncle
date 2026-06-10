import { type GameTrack, type Star } from "./types";

// Deterministic star placement from the Log ID (docs/galaxy-game.md, "The
// expanding galaxy"). The sector (days since the Fluncle epoch) maps to
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
const MIN_ARC_SPACING = 560;

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

export function ringRadius(sector: number): number {
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
        logId: placed.track.logId ?? seed,
        radius,
        sector,
        title: placed.track.title,
        trackId: placed.track.trackId,
        vOffset: ((fnv1a(`${seed}#v`) % 240) - 120) * 1.1,
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
