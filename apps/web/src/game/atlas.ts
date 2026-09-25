import { CLEAR_SPACE, spiralRadius } from "./placement";
import { type Star, type Vec2 } from "./types";

export const THREAD_TAIL = 0.6;

export const THREAD_STEP = 0.04;

export const ATLAS_MARGIN = 30;

export function atlasThreadEnd(stars: Star[]): number {
  let tip = 0;

  for (const star of stars) {
    tip = Math.max(tip, star.angle);
  }

  return tip + THREAD_TAIL;
}

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

export function atlasWorldRadius(stars: Star[], ship: Vec2): number {
  return Math.max(spiralRadius(atlasThreadEnd(stars)), Math.hypot(ship.x, ship.y), CLEAR_SPACE);
}

export function atlasScale(
  worldRadius: number,
  viewWidth: number,
  viewHeight: number,
  margin: number,
): number {
  const half = Math.min(viewWidth, viewHeight) / 2 - margin;

  return Math.max(1e-6, half) / Math.max(1, worldRadius);
}

export type AtlasMarkState = "logged" | "uncharted";

export function atlasMarkState(star: Pick<Star, "collected" | "lifetimeLogged">): AtlasMarkState {
  return star.collected || star.lifetimeLogged === true ? "logged" : "uncharted";
}

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
