import { describe, expect, it } from "vitest";

import {
  ATLAS_MARGIN,
  THREAD_TAIL,
  atlasCaption,
  atlasMarkState,
  atlasScale,
  atlasThreadEnd,
  atlasWorldRadius,
  frontierTipIndex,
  nearestStarIndex,
} from "./atlas";
import { CLEAR_SPACE, placeStars, spiralRadius } from "./placement";
import { applyLifetimeMarkers } from "./progress";
import { type GameTrack, type Star } from "./types";

function track(logId: string, index: number): GameTrack {
  return {
    addedAt: "2026-05-30T00:00:00.000Z",
    artists: [`Artist ${index}`],
    logId,
    spotifyUrl: `https://open.spotify.com/track/${index}`,
    title: `Banger ${index}`,
    trackId: `track-${index}`,
  };
}

const TRACKS: GameTrack[] = [
  track("000.0.1A", 0),
  track("000.4.2B", 1),
  track("000.9.9C", 2),
  track("004.0.1C", 3),
  track("018.5.7Y", 4),
  track("019.1.3D", 5),
  track("037.2.8Z", 6),
];

function starByLogId(stars: Star[], logId: string): Star {
  const star = stars.find((candidate) => candidate.logId === logId);

  if (star === undefined) {
    throw new Error(`expected a star at ${logId}`);
  }

  return star;
}

describe("atlas mark states", () => {
  it("maps run + lifetime progress to the three mark tiers", () => {
    const stars = placeStars(TRACKS);

    applyLifetimeMarkers(stars, ["004.0.1C"]);
    starByLogId(stars, "018.5.7Y").collected = true;

    expect(atlasMarkState(starByLogId(stars, "018.5.7Y"))).toBe("logged");
    expect(atlasMarkState(starByLogId(stars, "004.0.1C"))).toBe("lifetime");
    expect(atlasMarkState(starByLogId(stars, "000.0.1A"))).toBe("uncharted");
  });

  it("a star logged this run outranks its lifetime mark", () => {
    expect(atlasMarkState({ collected: true, lifetimeLogged: true })).toBe("logged");
  });
});

describe("atlas geometry", () => {
  it("ends the thread just past the frontier tip", () => {
    const stars = placeStars(TRACKS);
    const tip = stars[frontierTipIndex(stars)];

    if (tip === undefined) {
      throw new Error("expected a frontier tip");
    }

    expect(tip.logId).toBe("037.2.8Z");
    expect(atlasThreadEnd(stars)).toBe(tip.angle + THREAD_TAIL);
  });

  it("the world radius contains the thread, the ship, and Earth's clear space", () => {
    const stars = placeStars(TRACKS);
    const threadRadius = spiralRadius(atlasThreadEnd(stars));

    expect(atlasWorldRadius(stars, { x: 0, y: 0 })).toBe(threadRadius);
    // A ship past the frontier stretches the fit so it stays on the map.
    expect(atlasWorldRadius(stars, { x: 0, y: -(threadRadius + 500) })).toBe(threadRadius + 500);
    expect(atlasWorldRadius([], { x: 0, y: 0 })).toBeGreaterThanOrEqual(CLEAR_SPACE);
  });

  it("zoom-to-fit keeps the whole spiral inside the view with margin", () => {
    // The tight-fit contract: the world radius maps exactly onto the view's
    // shorter half-axis minus the margin.
    expect(4200 * atlasScale(4200, 480, 270, ATLAS_MARGIN)).toBeCloseTo(135 - ATLAS_MARGIN, 9);

    const stars = placeStars(TRACKS);
    const worldRadius = atlasWorldRadius(stars, { x: 0, y: 0 });
    const scale = atlasScale(worldRadius, 480, 270, ATLAS_MARGIN);

    expect(scale).toBeGreaterThan(0);

    for (const star of stars) {
      expect(Math.abs(star.x * scale)).toBeLessThanOrEqual(240 - ATLAS_MARGIN + 1e-9);
      expect(Math.abs(star.y * scale)).toBeLessThanOrEqual(135 - ATLAS_MARGIN + 1e-9);
    }
  });

  it("nearest star respects the hover threshold", () => {
    const stars = placeStars(TRACKS);
    const target = starByLogId(stars, "004.0.1C");
    const targetIndex = stars.indexOf(target);

    expect(nearestStarIndex(stars, target.x + 3, target.y - 2)).toBe(targetIndex);
    expect(nearestStarIndex(stars, target.x + 3, target.y - 2, 1)).toBe(-1);
  });
});

describe("atlas caption", () => {
  it("reads the growth story in one line", () => {
    expect(atlasCaption(placeStars(TRACKS))).toBe("7 findings · day 0–37 of the voyage");
  });

  it("collapses a single day and a singular finding", () => {
    expect(atlasCaption([{ sector: 4 }])).toBe("1 finding · day 4 of the voyage");
    expect(atlasCaption([{ sector: 4 }, { sector: 4 }])).toBe("2 findings · day 4 of the voyage");
  });

  it("stays honest when the sector is empty", () => {
    expect(atlasCaption([])).toBe("No findings charted yet.");
  });
});
