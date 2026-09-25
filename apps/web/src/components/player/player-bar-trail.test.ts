import { describe, expect, it } from "vitest";
import { nearestSeedIndex } from "./player-bar";

const seeds = ["a", "b", "c"].map((id) => ({ artists: [], id, title: id }));

describe("nearestSeedIndex — the one seed a phone keeps", () => {
  it("is the most recent seed when no sonic view is open", () => {
    expect(nearestSeedIndex(seeds, undefined)).toBe(2);
  });

  it("is the seed before the view open now, the nearest one back", () => {
    expect(nearestSeedIndex(seeds, "c")).toBe(1);
  });

  it("is the only seed, marked current, while its own view is open", () => {
    expect(nearestSeedIndex(seeds.slice(0, 1), "a")).toBe(0);
  });
});
