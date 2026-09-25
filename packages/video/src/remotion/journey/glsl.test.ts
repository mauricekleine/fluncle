import { describe, expect, test } from "bun:test";

import { stripGlslComments } from "../../pipeline/shader-structure";
import { GLSL } from "./glsl";

const FORBIDDEN = /\b(round|tanh|trunc|sinh|cosh|roundEven)\s*\(/;

const balanced = (src: string, open: string, close: string): boolean => {
  let depth = 0;
  for (const ch of src) {
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
};

describe("GLSL snippet library — structural smoke", () => {
  for (const [name, body] of Object.entries(GLSL)) {
    describe(name, () => {
      const code = stripGlslComments(body);

      test("is a non-empty GLSL string", () => {
        expect(typeof body).toBe("string");
        expect(body.length).toBeGreaterThan(0);
      });

      test("has balanced braces and parens", () => {
        expect(balanced(code, "{", "}")).toBe(true);
        expect(balanced(code, "(", ")")).toBe(true);
      });

      test("uses no WebGL1-forbidden builtin (round/tanh/trunc)", () => {
        expect(FORBIDDEN.test(code)).toBe(false);
      });
    });
  }
});

describe("presence snippets define their advertised functions", () => {
  const defines = (body: string, fn: string): boolean => new RegExp(`\\b${fn}\\s*\\(`).test(body);

  test("sdfPresence carries the whole SDF vocabulary", () => {
    const s = GLSL.sdfPresence;
    for (const fn of [
      "sdfRound",
      "ign",
      "smax",
      "sminV",
      "opRepeat",
      "opRepeatLim",
      "sdCapsule",
      "sdRoundCone",
      "sdEllipsoid",
      "sd2dSegment",
      "sd2dTriangle",
      "calcNormal4",
    ]) {
      expect(defines(s, fn)).toBe(true);
    }

    expect(/float\s+map\s*\(\s*vec3/.test(s)).toBe(true);

    expect(/vec2\s+sminV/.test(s)).toBe(true);

    expect(/floor\s*\(\s*v\s*\+\s*0\.5\s*\)/.test(s)).toBe(true);
  });

  test("glowWithDirt defines the additive-light-with-dirt helper", () => {
    expect(defines(GLSL.glowWithDirt, "glowWithDirt")).toBe(true);
    expect(defines(GLSL.glowWithDirt, "glowDirtSpeckle")).toBe(true);

    expect(GLSL.glowWithDirt).toContain("step(0.82 - 0.30 * lum, n)");
  });

  test("hiddenLineOcclusion defines the running-max ridge occluder", () => {
    expect(defines(GLSL.hiddenLineOcclusion, "hiddenLine")).toBe(true);

    expect(GLSL.hiddenLineOcclusion).toContain("peak = max(peak, h)");
    expect(GLSL.hiddenLineOcclusion).toContain("inout float peak");
  });

  test("rampRetint re-imposes the source luma (monotonic ordering)", () => {
    expect(defines(GLSL.rampRetint, "rampRetint")).toBe(true);
    expect(defines(GLSL.rampRetint, "paletteRamp")).toBe(true);

    expect(GLSL.rampRetint).toContain("l / hl");
  });
});
