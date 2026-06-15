import { describe, expect, it } from "vitest";
import { galaxyForVibe } from "./galaxies";

// The galaxy a finding belongs to is derived from its vibe coordinate: X =
// Light(-1)↔Dark(+1), Y = Floaty(-1)↔Driving(+1). The axes are inclusive toward
// dark/driving (x>=0, y>=0) so every point lands in exactly one galaxy.
describe("galaxyForVibe", () => {
  it("maps each quadrant to its galaxy", () => {
    expect(galaxyForVibe(-0.5, 0.5)).toBe("solar"); // light + driving
    expect(galaxyForVibe(0.5, 0.5)).toBe("nebular"); // dark + driving
    expect(galaxyForVibe(-0.5, -0.5)).toBe("lunar"); // light + floaty
    expect(galaxyForVibe(0.5, -0.5)).toBe("astral"); // dark + floaty
  });

  it("resolves the axes and origin deterministically", () => {
    expect(galaxyForVibe(0, 0)).toBe("nebular");
    expect(galaxyForVibe(-0.01, 0)).toBe("solar");
    expect(galaxyForVibe(0, -0.01)).toBe("astral");
    expect(galaxyForVibe(-0.01, -0.01)).toBe("lunar");
  });
});
