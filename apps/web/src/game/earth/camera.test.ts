import { describe, expect, it } from "vitest";
import { clampCamera, followCamera } from "./camera";

describe("clampCamera", () => {
  it("centers on the target inside a large world", () => {
    const cam = clampCamera(400, 400, 240, 208, 896, 768);
    expect(cam.x).toBe(280);
    expect(cam.y).toBe(296);
  });

  it("clamps to the world's near edge", () => {
    const cam = clampCamera(10, 10, 240, 208, 896, 768);
    expect(cam.x).toBe(0);
    expect(cam.y).toBe(0);
  });

  it("clamps to the world's far edge", () => {
    const cam = clampCamera(890, 760, 240, 208, 896, 768);
    expect(cam.x).toBe(896 - 240);
    expect(cam.y).toBe(768 - 208);
  });

  it("centers a world smaller than the viewport", () => {
    const cam = clampCamera(50, 50, 240, 208, 100, 100);
    expect(cam.x).toBe((100 - 240) / 2);
    expect(cam.y).toBe((100 - 208) / 2);
  });
});

describe("followCamera", () => {
  it("snaps to the goal at ease 1", () => {
    const cam = followCamera({ x: 0, y: 0 }, 400, 400, 240, 208, 896, 768, 1);
    expect(cam.x).toBe(280);
    expect(cam.y).toBe(296);
  });

  it("eases partway toward the goal at ease < 1", () => {
    const cam = followCamera({ x: 0, y: 0 }, 400, 400, 240, 208, 896, 768, 0.5);
    expect(cam.x).toBe(140);
    expect(cam.y).toBe(148);
  });
});
