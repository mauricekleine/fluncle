import { describe, expect, it } from "vitest";
import { vibeQuadrant } from "./vibe-map";

// The galaxy a finding belongs to is derived from its vibe coordinate: X =
// Light(-1)↔Dark(+1), Y = Floaty(-1)↔Driving(+1). The axes are inclusive toward
// dark/driving (x>=0, y>=0) so every point lands in exactly one quadrant.
describe("vibeQuadrant (galaxy from coordinate)", () => {
  it("maps each quadrant to its galaxy", () => {
    expect(vibeQuadrant(-0.5, 0.5)).toBe("solar"); // light + driving
    expect(vibeQuadrant(0.5, 0.5)).toBe("nebular"); // dark + driving
    expect(vibeQuadrant(-0.5, -0.5)).toBe("lunar"); // light + floaty
    expect(vibeQuadrant(0.5, -0.5)).toBe("deep"); // dark + floaty
  });

  it("resolves the axes and origin deterministically", () => {
    expect(vibeQuadrant(0, 0)).toBe("nebular");
    expect(vibeQuadrant(-0.01, 0)).toBe("solar");
    expect(vibeQuadrant(0, -0.01)).toBe("deep");
    expect(vibeQuadrant(-0.01, -0.01)).toBe("lunar");
  });
});
