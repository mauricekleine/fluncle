import { CLEAR_SPACE, spiralRadius } from "./placement";
import { type Star, type Vec2 } from "./types";

// The atlas: the pure math behind the top-down voyage map (drawn by render.ts,
// toggled on C). Everything here is canvas-free and deterministic so the map's
// geometry is unit-testable. The curve itself is NOT re-derived here — the atlas
// draws placement.ts's own spiralPoint export, the same function that placed
// the stars, so the thread and its stars cannot drift apart.

/** Extra thread drawn past the frontier tip (radians of arc): the voyage goes on. */
export const THREAD_TAIL = 0.6;

/** Angular step when sampling the thread into a polyline (radians). */
export const THREAD_STEP = 0.04;

/** Canvas margin the zoom-to-fit keeps clear around the spiral (internal px). */
export const ATLAS_MARGIN = 30;

/** θ where the drawn thread ends: the furthest finding plus a short tail. */
export function atlasThreadEnd(stars: Star[]): number {
  let tip = 0;

  for (const star of stars) {
    tip = Math.max(tip, star.angle);
  }

  return tip + THREAD_TAIL;
}

/** The frontier tip: the index of the furthest-out finding, or -1 when empty. */
export function frontierTipIndex(stars: Star[]): number {
  let index = -1;
  let best = Number.NEGATIVE_INFINITY;

  for (let candidate = 0; candidate < stars.length; candidate++) {
    const star = stars[candidate];

    if (star !== undefined && star.angle > best) {
      best = star.angle;
      index = candidate;
    }
  }

  return index;
}

/** World radius the map must contain: the whole thread, the ship, never less than Earth's clear space. */
export function atlasWorldRadius(stars: Star[], ship: Vec2): number {
  return Math.max(spiralRadius(atlasThreadEnd(stars)), Math.hypot(ship.x, ship.y), CLEAR_SPACE);
}

/** Zoom-to-fit: px per world unit so a worldRadius circle fits the view with margin. */
export function atlasScale(
  worldRadius: number,
  viewWidth: number,
  viewHeight: number,
  margin: number,
): number {
  const half = Math.min(viewWidth, viewHeight) / 2 - margin;

  return Math.max(1e-6, half) / Math.max(1, worldRadius);
}

// The map's two-tier read of the log: a star logged THIS run burns bright, a
// star only in the signed-in lifetime log is a quieter fill (map knowledge
// carrying across deaths), and an uncharted star is a dim hollow ring.
export type AtlasMarkState = "lifetime" | "logged" | "uncharted";

export function atlasMarkState(star: Pick<Star, "collected" | "lifetimeLogged">): AtlasMarkState {
  if (star.collected) {
    return "logged";
  }

  return star.lifetimeLogged === true ? "lifetime" : "uncharted";
}

// The corner caption: the growth story in one deadpan line. The day numbers are
// the Log ID's own day-sectors (the first group of the coordinate), so "day 4"
// reads back to a "004." finding.
export function atlasCaption(stars: ReadonlyArray<Pick<Star, "sector">>): string {
  if (stars.length === 0) {
    return "No findings charted yet.";
  }

  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;

  for (const star of stars) {
    first = Math.min(first, star.sector);
    last = Math.max(last, star.sector);
  }

  const count = stars.length === 1 ? "1 finding" : `${stars.length} findings`;
  const days = first === last ? `day ${first}` : `day ${first}–${last}`;

  return `${count} · ${days} of the voyage`;
}

/** Nearest star to a world point, or -1 when none is within maxDistance. */
export function nearestStarIndex(
  stars: Star[],
  x: number,
  y: number,
  maxDistance = Number.POSITIVE_INFINITY,
): number {
  let index = -1;
  let best = maxDistance;

  for (let candidate = 0; candidate < stars.length; candidate++) {
    const star = stars[candidate];

    if (star === undefined) {
      continue;
    }

    const distance = Math.hypot(star.x - x, star.y - y);

    if (distance < best) {
      best = distance;
      index = candidate;
    }
  }

  return index;
}
