import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { GLSL } from "../remotion/journey/glsl";

import {
  classifyCompositionStructure,
  classifyShaderStructure,
  labelWithStructure,
  type StructureFamily,
  STRUCTURE_FAMILIES,
  stripGlslComments,
  toStructureManifest,
} from "./shader-structure";

const FIXTURES = path.resolve(import.meta.dirname, "__fixtures__", "structure");
const glsl = GLSL as unknown as Record<string, string>;

function classifyFixture(logId: string) {
  const source = readFileSync(path.join(FIXTURES, `${logId}.composition.tsx.txt`), "utf8");
  const result = classifyCompositionStructure(source, glsl);
  assert.ok(result, `${logId} fixture must resolve + classify (got null)`);
  return result;
}

const GROUND_TRUTH: { logId: string; family: StructureFamily; vehicle: string }[] = [
  { family: "cellular", logId: "027.5.4D", vehicle: "crystal scaffold" },
  { family: "cellular", logId: "027.2.8R", vehicle: "basalt organ" },
  { family: "cellular", logId: "033.0.1O", vehicle: "tidal cell field" },
  { family: "filament", logId: "032.0.4L", vehicle: "wound filament" },
  { family: "caustic", logId: "026.4.0E", vehicle: "caustic uprising" },
  { family: "flow", logId: "024.7.3Y", vehicle: "groove canyon" },
  { family: "flow", logId: "032.0.6R", vehicle: "pressure strata" },
];

describe("classifyCompositionStructure — real shipped bodies (ground truth)", () => {
  for (const { logId, family, vehicle } of GROUND_TRUTH) {
    test(`${logId} "${vehicle}" ⇒ ${family}`, () => {
      const result = classifyFixture(logId);
      expect(result.dominant).toBe(family);

      expect(result.confidence).toBeGreaterThan(0);
      expect(result.signals.length).toBeGreaterThan(0);
    });
  }

  test("the three cellular offenders all read cellular with high confidence", () => {
    for (const logId of ["027.5.4D", "027.2.8R", "033.0.1O"]) {
      const result = classifyFixture(logId);
      expect(result.dominant).toBe("cellular");

      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });

  test("027.2.8R and 033.0.1O are caught via voronoi3 (no ${GLSL.voronoi} import)", () => {
    for (const logId of ["027.2.8R", "033.0.1O"]) {
      const source = readFileSync(path.join(FIXTURES, `${logId}.composition.tsx.txt`), "utf8");
      expect(source.includes("${GLSL.voronoi}")).toBe(false);
      expect(classifyFixture(logId).dominant).toBe("cellular");
    }
  });

  test("the flow↔filament pair is separated by dataflow, not by name", () => {
    const filamentBody = classifyFixture("032.0.4L");
    expect(filamentBody.dominant).toBe("filament");
    expect(filamentBody.secondary).toBe("flow");

    const flowBody = classifyFixture("024.7.3Y");
    expect(flowBody.dominant).toBe("flow");
    expect(flowBody.secondary).toBe("filament");
  });
});

describe("classifyShaderStructure — synthetic families", () => {
  test("cellular: a hand-rolled worley min-distance loop", () => {
    const body = `
      void main() {
        vec2 n = floor(p); vec2 f = fract(p);
        float f1 = 8.0; float f2 = 8.0;
        for (int i = -1; i <= 1; i++) {
          vec2 o = hash22(n); float d = dot(o, o);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
        float wall = f2 - f1;
      }`;
    const r = classifyShaderStructure(body);
    expect(r.dominant).toBe("cellular");
  });

  test("caustic: a caustic() call", () => {
    const body = `void main() { float c = caustic(uv, u_time, 1.5, 6); fragColor = vec4(c); }`;
    expect(classifyShaderStructure(body).dominant).toBe("caustic");
  });

  test("filament: a ridged inversion on a void", () => {
    const body = `
      void main() {
        float n = noise(uv);
        float ridge = pow(1.0 - abs(2.0 * n - 1.0), 4.0);
        float fil = smoothstep(0.5, 0.6, ridge);
        fragColor = vec4(fil);
      }`;
    expect(classifyShaderStructure(body).dominant).toBe("filament");
  });

  test("flow: a domain-warp field", () => {
    const body = `void main() { float n = domainWarp(uv * 2.0, 4); fragColor = vec4(n); }`;
    expect(classifyShaderStructure(body).dominant).toBe("flow");
  });

  test("lattice: a dot-field stipple screen", () => {
    const body = `void main() { float d = dotField(uv, u_res, 40.0, 0.4, 0.5, 1.0); fragColor = vec4(d); }`;
    expect(classifyShaderStructure(body).dominant).toBe("lattice");
  });

  test("radial: a polarFold kaleido", () => {
    const body = `void main() { vec2 q = polarFold(uv, 6.0); fragColor = vec4(length(q)); }`;
    expect(classifyShaderStructure(body).dominant).toBe("radial");
  });

  test("metaball: a raymarched SDF body", () => {
    const body = `
      float map(vec3 p) { return smin(sdSphere3(p, 1.0), sdSphere3(p - vec3(1.0), 0.8), 0.3); }
      void main() { float t = raymarch(ro, rd, 20.0); fragColor = vec4(t); }`;
    expect(classifyShaderStructure(body).dominant).toBe("metaball");
  });

  test("other: a flat fill clears nothing", () => {
    const body = `void main() { fragColor = vec4(u_palette[0], 1.0); }`;
    const r = classifyShaderStructure(body);
    expect(r.dominant).toBe("other");
    expect(r.confidence).toBe(0);
  });
});

describe("robustness", () => {
  test("comments cannot invent a family (structure is the CODE, not the prose)", () => {
    const body = `
      // Vehicle: crystal voronoi cell lattice — worley cells everywhere, F2 - F1 walls
      /* cellular caustic ridge filament kaleido raymarch */
      void main() { float n = domainWarp(uv, 4); fragColor = vec4(n); }`;
    const r = classifyShaderStructure(body);
    expect(r.dominant).toBe("flow");
    expect(r.signals.some((s) => s.family === "cellular")).toBe(false);
  });

  test("stripGlslComments removes // and /* */ but keeps code", () => {
    const out = stripGlslComments("a(); // line\n/* block */ b();");
    expect(out).toContain("a();");
    expect(out).toContain("b();");
    expect(out).not.toContain("line");
    expect(out).not.toContain("block");
  });

  test("every dominant is a member of the closed family set", () => {
    for (const { logId } of GROUND_TRUTH) {
      expect(STRUCTURE_FAMILIES).toContain(classifyFixture(logId).dominant);
    }
  });
});

describe("manifest + label helpers", () => {
  test("toStructureManifest drops an absent secondary", () => {
    const cellular = classifyFixture("033.0.1O");
    const manifest = toStructureManifest(cellular);
    expect(manifest.dominant).toBe("cellular");
    expect(typeof manifest.confidence).toBe("number");
    expect("secondary" in manifest).toBe(cellular.secondary !== undefined);
  });

  test("labelWithStructure pairs the poetic name with the checked family", () => {
    expect(labelWithStructure("basalt organ", "cellular")).toBe("basalt organ (cellular)");
    expect(labelWithStructure("  ", "flow")).toBe("(no vehicle) (flow)");
    expect(labelWithStructure("wound filament", null)).toBe("wound filament");
  });
});
