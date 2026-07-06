import { describe, expect, it } from "vitest";

import { CLEAR_SPACE, placeStars, spiralPoint, spiralRadius } from "./placement";
import { type GameTrack } from "./types";

// The shared-curve invariant: placeStars places with spiralPoint and the atlas
// draws spiralPoint, so every placed star must sit EXACTLY on the curve at its
// θ — toBe, not toBeCloseTo, because it is the same function on the same
// floats. If placement ever stops consuming its own export, this fails before
// the map and the stars can drift apart.

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

// A heavy day 0 (exercises the arc-spacing advance), a quiet gap, and far
// sectors — the layouts the thread has to breathe through.
const TRACKS: GameTrack[] = [
  track("000.0.1A", 0),
  track("000.4.2B", 1),
  track("000.9.9C", 2),
  track("004.0.1C", 3),
  track("018.5.7Y", 4),
  track("019.1.3D", 5),
  track("037.2.8Z", 6),
];

describe("the shared voyage curve", () => {
  it("places every star exactly on spiralPoint at its θ", () => {
    const stars = placeStars(TRACKS);

    expect(stars).toHaveLength(TRACKS.length);

    for (const star of stars) {
      const point = spiralPoint(star.angle);

      expect(star.x).toBe(point.x);
      expect(star.y).toBe(point.y);
      expect(star.radius).toBe(spiralRadius(star.angle));
      expect(star.radius).toBeGreaterThanOrEqual(CLEAR_SPACE);
      expect(Math.hypot(star.x, star.y)).toBeCloseTo(star.radius, 6);
    }
  });

  it("keeps the radius strictly rising along the thread", () => {
    const stars = placeStars(TRACKS);
    const byAngle = [...stars].sort((a, b) => a.angle - b.angle);

    for (let index = 1; index < byAngle.length; index++) {
      const previous = byAngle[index - 1];
      const current = byAngle[index];

      if (previous === undefined || current === undefined) {
        throw new Error("expected placed stars");
      }

      expect(current.radius).toBeGreaterThan(previous.radius);
    }
  });
});
