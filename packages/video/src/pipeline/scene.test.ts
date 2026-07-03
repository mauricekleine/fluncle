// Coverage for the scene contract (fluncle.scene/1) + the emitter helpers. All
// pure — no fs, no GL, no render. The round-trip PIXEL proof lives in
// scene-roundtrip.ts (it needs a GL context); these lock the schema, the
// interpolation guard, the live-ready scan, and the folds.

import { describe, expect, test } from "bun:test";

import {
  buildScene,
  detectGlsl3,
  extractBloom,
  extractReactivity,
  extractTextureNames,
  foldCleared,
  lintScenePalette,
  locateFragmentLiteral,
  resolveGlslBody,
  scanCustomUniforms,
  SCENE_HEADER_VERSION,
  SCENE_METRICS_VERSION,
  SCENE_SCHEMA,
  validateScene,
} from "./scene";
import { validateSceneStrict } from "./validate-scene";

const GLSL_FIXTURE: Record<string, string> = {
  filmGrain: "vec3 filmGrain(vec3 c, vec2 uv, float t, float a){ return c; }",
  hash: "float hash21(vec2 p){ return fract(sin(dot(p, vec2(1.0,2.0)))*43758.5); }",
};

// A LIVE-READY body: header uniforms only, all deps bare `${GLSL.*}` refs.
const LIVE_READY_SOURCE = `
const FRAG = /* glsl */ \`
\${GLSL.hash}
\${GLSL.filmGrain}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 col = u_palette[0] * (0.5 + 0.5 * u_energy) + u_beatPulse * 0.1;
  GrainOpts go = grainFineEmulsion();
  go.amount = 0.05;
  col = filmGrain(col, uv, u_time, go);
  gl_FragColor = vec4(col, 1.0);
}
\`;
<ShaderLayer fragmentShader={FRAG} bloom={{ threshold: 0.72, intensity: 0.6, radius: 0.9 }} reactivity={{ drop: { riseMs: 900, holdMs: 400, fallMs: 2200, peakTimeMs: 8000 } }} />
`;

// A NOT-live-ready body: declares a custom clip-time uniform.
const CUSTOM_UNIFORM_SOURCE = `
const FRAG = /* glsl */ \`
\${GLSL.hash}
uniform float u_settle;
void main() {
  gl_FragColor = vec4(u_palette[0] * u_settle, 1.0);
}
\`;
`;

describe("locateFragmentLiteral", () => {
  test("finds the literal containing void main()", () => {
    const r = locateFragmentLiteral(LIVE_READY_SOURCE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.raw).toContain("void main(");
      expect(r.raw).toContain("${GLSL.hash}");
    }
  });

  test("errors when no fragment literal is present", () => {
    const r = locateFragmentLiteral("const x = 1; // no shader here");
    expect(r.ok).toBe(false);
  });
});

describe("resolveGlslBody — the ${GLSL.*}-only interpolation guard", () => {
  test("inlines bare GLSL members", () => {
    const located = locateFragmentLiteral(LIVE_READY_SOURCE);
    expect(located.ok).toBe(true);
    if (!located.ok) {
      return;
    }
    const r = resolveGlslBody(located.raw, GLSL_FIXTURE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toContain("float hash21");
      expect(r.body).toContain("vec3 filmGrain");
      expect(r.body).not.toContain("${");
    }
  });

  test("REFUSES a non-GLSL interpolation", () => {
    const r = resolveGlslBody("void main(){ float x = ${DROP_MS}; }", GLSL_FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("not a bare GLSL member");
    }
  });

  test("REFUSES a GLSL member absent from the object", () => {
    const r = resolveGlslBody("void main(){ ${GLSL.doesNotExist} }", GLSL_FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("not a member of the GLSL object");
    }
  });
});

describe("scanCustomUniforms — the live-ready static scan", () => {
  test("a header-only body has no custom uniforms", () => {
    const body = "void main(){ gl_FragColor = vec4(u_palette[0] * u_energy, 1.0); }";
    expect(scanCustomUniforms(body)).toEqual([]);
  });

  test("flags a custom clip-time uniform", () => {
    const body = "uniform float u_settle;\nvoid main(){ gl_FragColor = vec4(u_settle); }";
    expect(scanCustomUniforms(body)).toEqual(["u_settle"]);
  });

  test("a declared texture + its aspect uniform are allowed", () => {
    const body = "uniform sampler2D art;\nuniform float artAspectRatio;\nvoid main(){}";
    expect(scanCustomUniforms(body, ["art"])).toEqual([]);
  });
});

describe("prop extraction", () => {
  test("detectGlsl3", () => {
    expect(detectGlsl3("<ShaderLayer glsl3 />")).toBe(true);
    expect(detectGlsl3("<ShaderLayer glsl3={true} />")).toBe(true);
    expect(detectGlsl3("<ShaderLayer fragmentShader={x} />")).toBe(false);
  });

  test("extractBloom reads the literal knobs", () => {
    expect(extractBloom(LIVE_READY_SOURCE)).toEqual({
      intensity: 0.6,
      radius: 0.9,
      threshold: 0.72,
    });
  });

  test("extractReactivity keeps the shape and drops peakTimeMs", () => {
    const r = extractReactivity(LIVE_READY_SOURCE);
    expect(r).toEqual({ drop: { fallMs: 2200, holdMs: 400, riseMs: 900 }, swellBeatWeight: 0 });
    expect(r && "peakTimeMs" in r.drop).toBe(false);
  });

  test("extractTextureNames reads sampler keys", () => {
    expect(extractTextureNames("<ShaderLayer textures={{ art: track.artworkUrl }} />")).toEqual([
      "art",
    ]);
    expect(extractTextureNames("<ShaderLayer fragmentShader={x} />")).toEqual([]);
  });
});

describe("foldCleared", () => {
  const at = "2026-07-03T00:00:00.000Z";

  test("maps hard-gate verdicts to pass/fail", () => {
    const report = {
      arc: { verdict: "evolving" },
      beatPull: { beatLocked: false },
      flashSafety: { verdict: "safe" },
    };
    expect(foldCleared(report, at)).toEqual({
      arc: "pass",
      at,
      beatPull: "pass",
      flash: "pass",
      metricsVersion: SCENE_METRICS_VERSION,
    });
  });

  test("failing gates + inconclusive arc", () => {
    const report = {
      arc: { verdict: "inconclusive" },
      beatPull: { beatLocked: true },
      flashSafety: { verdict: "unsafe" },
      metricsVersion: "custom/9",
    };
    expect(foldCleared(report, at)).toEqual({
      arc: "inconclusive",
      at,
      beatPull: "fail",
      flash: "fail",
      metricsVersion: "custom/9",
    });
  });

  test("a missing/empty report reads unknown", () => {
    expect(foldCleared(null, at)).toEqual({
      arc: "unknown",
      at,
      beatPull: "unknown",
      flash: "unknown",
      metricsVersion: SCENE_METRICS_VERSION,
    });
  });
});

describe("lintScenePalette — the Warm Dark ceiling", () => {
  test("a warm-dark ground passes", () => {
    expect(lintScenePalette({ palette: ["#171611", "#8e0a2e", "#cc5374", "#f4ead7"] })).toEqual([]);
  });

  test("a bright ground trips the ceiling", () => {
    const w = lintScenePalette({ palette: ["#f4ead7", "#8e0a2e", "#cc5374", "#f4ead7"] });
    expect(w.length).toBe(1);
    expect(w[0]).toContain("Warm Dark ceiling");
  });
});

describe("buildScene", () => {
  const at = "2026-07-03T12:00:00.000Z";
  const palette: [string, string, string, string] = ["#0b0a10", "#8e0a2e", "#cc5374", "#f4ead7"];

  test("a live-ready composition emits a live-ready scene", () => {
    const { scene, warnings } = buildScene({
      at,
      glsl: GLSL_FIXTURE,
      grainFamily: "grainChemicalDye",
      id: "032.0.4L",
      kind: "finding",
      metricsReport: {
        arc: { verdict: "evolving" },
        beatPull: { beatLocked: false },
        flashSafety: { verdict: "safe" },
      },
      palette,
      source: LIVE_READY_SOURCE,
    });
    expect(scene).not.toBeNull();
    if (!scene) {
      return;
    }
    expect(scene.schema).toBe(SCENE_SCHEMA);
    expect(scene.id).toBe("032.0.4L");
    expect(scene.kind).toBe("finding");
    expect(scene.glsl.headerVersion).toBe(SCENE_HEADER_VERSION);
    expect(scene.glsl.body).not.toContain("${");
    expect(scene.liveReady).toBe(true);
    expect(scene.liveReadyReasons).toEqual([]);
    expect(scene.bloom).toEqual({ intensity: 0.6, radius: 0.9, threshold: 0.72 });
    expect(scene.reactivity).toEqual({
      drop: { fallMs: 2200, holdMs: 400, riseMs: 900 },
      swellBeatWeight: 0,
    });
    expect(scene.cleared.flash).toBe("pass");
    expect(warnings).toEqual([]);
    // The scene round-trips through the defensive validator.
    expect(validateScene(scene)).not.toBeNull();
    // And through the strict one.
    expect(validateSceneStrict(scene).valid).toBe(true);
  });

  test("a custom-uniform composition emits but is NOT live-ready", () => {
    const { scene } = buildScene({
      at,
      glsl: GLSL_FIXTURE,
      grainFamily: "grainFineEmulsion",
      id: "027.9.5H",
      kind: "finding",
      metricsReport: null,
      palette,
      source: CUSTOM_UNIFORM_SOURCE,
    });
    expect(scene).not.toBeNull();
    if (!scene) {
      return;
    }
    expect(scene.liveReady).toBe(false);
    expect(scene.liveReadyReasons[0]).toContain("u_settle");
    // Still a structurally valid, uploadable scene.
    expect(validateSceneStrict(scene).valid).toBe(true);
  });

  test("an unresolvable interpolation skips emission (ship degrades)", () => {
    const { scene, warnings } = buildScene({
      at,
      glsl: GLSL_FIXTURE,
      grainFamily: null,
      id: "000.0.0X",
      kind: "finding",
      metricsReport: null,
      palette,
      source: "const F = `void main(){ float d = ${DROP_MS}; }`;",
    });
    expect(scene).toBeNull();
    expect(warnings[0]).toContain("not live-ready");
  });
});

describe("validateSceneStrict", () => {
  const valid = buildScene({
    at: "2026-07-03T00:00:00.000Z",
    glsl: GLSL_FIXTURE,
    grainFamily: "grainChemicalDye",
    id: "032.0.4L",
    kind: "finding",
    metricsReport: null,
    palette: ["#0b0a10", "#8e0a2e", "#cc5374", "#f4ead7"],
    source: LIVE_READY_SOURCE,
  }).scene;

  test("the emitted scene is strictly valid", () => {
    expect(valid).not.toBeNull();
    expect(validateSceneStrict(valid).errors).toEqual([]);
  });

  test("an unresolved body is rejected", () => {
    const r = validateSceneStrict({
      ...valid,
      glsl: { ...valid?.glsl, body: "void main(){ ${GLSL.x} }" },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === "glsl.body")).toBe(true);
  });

  test("a stray reactivity.peakTimeMs is rejected", () => {
    const r = validateSceneStrict({
      ...valid,
      reactivity: { drop: { fallMs: 1, holdMs: 1, peakTimeMs: 9, riseMs: 1 }, swellBeatWeight: 0 },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === "reactivity.peakTimeMs")).toBe(true);
  });

  test("a non-object is rejected cleanly", () => {
    expect(validateSceneStrict(null).valid).toBe(false);
    expect(validateSceneStrict("nope").valid).toBe(false);
  });
});
