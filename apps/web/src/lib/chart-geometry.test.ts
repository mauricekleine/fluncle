import { describe, expect, it } from "vitest";
import { chartGeometry } from "@/lib/chart-geometry";

const REACH_DIMS = { height: 220, padY: 18, width: 800 } as const;
const FUNNEL_DIMS = { height: 160, padY: 14, width: 800 } as const;

describe("chartGeometry", () => {
  it("spreads points across the width and inverts value into the padded height (reach dims)", () => {
    const geometry = chartGeometry([{ value: 0 }, { value: 50 }, { value: 100 }], REACH_DIMS);

    expect(geometry.line).toBe("0,202 400,110 800,18");
    expect(geometry.last).toEqual({ x: 800, y: 18 });
    expect(geometry.area).toBe("M0,220 L0,202 L400,110 L800,18 L800,220 Z");
    expect(geometry.min).toBe(0);
    expect(geometry.max).toBe(100);
  });

  it("pins a single point to the live edge, centered vertically (funnel dims)", () => {
    const geometry = chartGeometry([{ value: 42 }], FUNNEL_DIMS);

    expect(geometry.last).toEqual({ x: 800, y: 80 });
    expect(geometry.line).toBe("800,80");
    expect(geometry.max).toBe(42);
  });

  it("draws a flat series down the middle (span 0, no divide-by-zero)", () => {
    const geometry = chartGeometry([{ value: 7 }, { value: 7 }], FUNNEL_DIMS);

    expect(geometry.line).toBe("0,80 800,80");
    expect(Number.isNaN(geometry.last.y)).toBe(false);
  });

  it("guards an empty series: empty paths, a centered fallback, no NaN", () => {
    const geometry = chartGeometry([], REACH_DIMS);

    expect(geometry.line).toBe("");
    expect(geometry.area).toBe("");
    expect(geometry.last).toEqual({ x: 800, y: 110 });
    expect(geometry.min).toBe(0);
    expect(geometry.max).toBe(0);
  });
});
