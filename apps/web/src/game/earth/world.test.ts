import { describe, expect, it } from "vitest";
import { TILE } from "./sprites";
import { isGround, REGION_BOXES, SPAWN, WORLD_H, WORLD_W } from "./world";

describe("world terrain", () => {
  it("spawn is on walkable ground", () => {
    expect(isGround(Math.floor(SPAWN.x / TILE), Math.floor(SPAWN.y / TILE))).toBe(true);
  });

  it("the cosmos corner is not ground", () => {
    expect(isGround(0, 0)).toBe(false);
  });

  it("out-of-bounds tiles are not ground", () => {
    expect(isGround(-1, 0)).toBe(false);
    expect(isGround(WORLD_W, 0)).toBe(false);
    expect(isGround(0, WORLD_H)).toBe(false);
  });

  it("each region box's center is ground", () => {
    for (const box of Object.values(REGION_BOXES)) {
      const cx = Math.floor((box.x0 + box.x1) / 2);
      const cy = Math.floor((box.y0 + box.y1) / 2);
      expect(isGround(cx, cy)).toBe(true);
    }
  });

  it("region boxes lie within the world bounds", () => {
    for (const box of Object.values(REGION_BOXES)) {
      expect(box.x0).toBeGreaterThanOrEqual(0);
      expect(box.y0).toBeGreaterThanOrEqual(0);
      expect(box.x1).toBeLessThan(WORLD_W);
      expect(box.y1).toBeLessThan(WORLD_H);
    }
  });
});
