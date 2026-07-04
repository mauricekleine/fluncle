// Structural compile-smoke for the GLSL snippet library — no GPU (bun test has no
// WebGL). It catches the classes of breakage that actually bite this file: a template
// literal closed early by a backtick in a comment (that would fail to PARSE, so a
// snippet even being a string is itself a check), unbalanced braces/parens, a
// WebGL1-forbidden builtin sneaking in (`round`/`tanh`/`trunc` — GLSL ES 1.00 lacks
// them), and a new snippet not actually defining the functions it advertises. The
// REAL GL compile is the workbench still rendered on ANGLE/SwiftShader (see the PR
// notes); this is the fast, deterministic guard that keeps the kit honest in CI.

import { describe, expect, test } from "bun:test";

import { stripGlslComments } from "../../pipeline/shader-structure";
import { GLSL } from "./glsl";

// GLSL ES 1.00 has no round()/tanh()/trunc() (case-sensitive, so the kit's own
// `sdfRound` helper — capital R — is not a false positive).
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
      // (An UNescaped backtick would close the template literal → the module would
      // fail to import, so a stray-backtick check would be redundant; `dotField`
      // legitimately carries an escaped backtick inside a GLSL comment.)
    });
  }
});

// The presence additions must actually define what their doc + registry advertise.
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
    // calcNormal4 needs a map prototype (forward-declared here, duplicate-safe).
    expect(/float\s+map\s*\(\s*vec3/.test(s)).toBe(true);
    // vec2 smooth-union returns distance + blend factor.
    expect(/vec2\s+sminV/.test(s)).toBe(true);
    // WebGL1 round substitute, never the builtin.
    expect(/floor\s*\(\s*v\s*\+\s*0\.5\s*\)/.test(s)).toBe(true);
  });

  test("glowWithDirt defines the additive-light-with-dirt helper", () => {
    expect(defines(GLSL.glowWithDirt, "glowWithDirt")).toBe(true);
    expect(defines(GLSL.glowWithDirt, "glowDirtSpeckle")).toBe(true);
    // the dirt is SUBTRACTED (dark motes) with a luminance-scaled threshold.
    expect(GLSL.glowWithDirt).toContain("step(0.82 - 0.30 * lum, n)");
  });

  test("hiddenLineOcclusion defines the running-max ridge occluder", () => {
    expect(defines(GLSL.hiddenLineOcclusion, "hiddenLine")).toBe(true);
    // the front-to-back running max: a line shows only where it clears `peak`.
    expect(GLSL.hiddenLineOcclusion).toContain("peak = max(peak, h)");
    expect(GLSL.hiddenLineOcclusion).toContain("inout float peak");
  });

  test("rampRetint re-imposes the source luma (monotonic ordering)", () => {
    expect(defines(GLSL.rampRetint, "rampRetint")).toBe(true);
    expect(defines(GLSL.rampRetint, "paletteRamp")).toBe(true);
    // the luma re-imposition (hue * l/hl) is the ordering guarantee.
    expect(GLSL.rampRetint).toContain("l / hl");
  });
});
