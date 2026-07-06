// Coverage for the scene contract (fluncle.scene/1) + the emitter helpers. All
// pure — no fs, no GL, no render. The round-trip PIXEL proof lives in
// scene-roundtrip.ts (it needs a GL context); these lock the schema, the
// interpolation guard, the live-ready scan, and the folds.

import { describe, expect, test } from "bun:test";

import {
  buildScene,
  detectGlsl3,
  extractBloom,
  extractPaletteStops,
  extractReactivity,
  extractTextureNames,
  foldCleared,
  lintScenePalette,
  locateFragmentLiteral,
  resolveGlslBody,
  resolveSceneTextures,
  scanCustomUniforms,
  SCENE_HEADER_VERSION,
  SCENE_METRICS_VERSION,
  SCENE_SCHEMA,
  textureSourceForName,
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

// A composition that HARD-CODES warm retint stops via a local const + paletteStops
// (the 024.7.3Y / 026.4.0E shape) — these stops must win over the artwork palette.
const RETINT_STOPS_SOURCE = `
const stops: [string, string, string, string] = ["#0e0a06", "#7c391a", "#e59a3f", "#f3e7cf"];
const FRAG = /* glsl */ \`
\${GLSL.hash}
void main() {
  GrainOpts go = grainChemicalDye();
  go.amount = 0.06;
  gl_FragColor = vec4(u_palette[0], 1.0);
}
\`;
<ShaderLayer fragmentShader={FRAG} paletteStops={stops} />
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

  test("textureSourceForName — the sampler-name convention", () => {
    expect(textureSourceForName("u_plate")).toBe("plate");
    expect(textureSourceForName("u_plateBackground")).toBe("plate-background");
    expect(textureSourceForName("art")).toBe("artwork");
    expect(textureSourceForName("u_plateX")).toBe("artwork");
  });
});

describe("extractPaletteStops — composition palette fidelity", () => {
  test("resolves an inline paletteStops array", () => {
    expect(
      extractPaletteStops(
        '<ShaderLayer paletteStops={["#0e0a06", "#7c391a", "#e59a3f", "#f3e7cf"]} />',
      ),
    ).toEqual(["#0e0a06", "#7c391a", "#e59a3f", "#f3e7cf"]);
  });

  test("resolves a `paletteStops={stops}` local const array", () => {
    expect(extractPaletteStops(RETINT_STOPS_SOURCE)).toEqual([
      "#0e0a06",
      "#7c391a",
      "#e59a3f",
      "#f3e7cf",
    ]);
  });

  test("resolves a full inline palette object by role, not position", () => {
    expect(
      extractPaletteStops(
        '<ShaderLayer palette={{ accent: "#7c391a", ink: "#f3e7cf", background: "#0a0a0a", glow: "#e59a3f" }} />',
      ),
    ).toEqual(["#0a0a0a", "#7c391a", "#e59a3f", "#f3e7cf"]);
  });

  test("returns undefined for a computed or prop palette (props stays the source of truth)", () => {
    // `palette={paletteMix(palette.swatches)}` / `palette={palette}` == props.palette.
    expect(
      extractPaletteStops("<ShaderLayer fragmentShader={F} palette={mixedPalette} />"),
    ).toBeUndefined();
    expect(
      extractPaletteStops("<ShaderLayer fragmentShader={F} palette={palette} />"),
    ).toBeUndefined();
    // A partial CloseCard palette is NOT a full four-role override.
    expect(
      extractPaletteStops('<CloseCard palette={{ accent: "#80c8a4", ink: "#e6f1ea" }} />'),
    ).toBeUndefined();
  });
});

describe("resolveSceneTextures — the host-side URL binding", () => {
  const plateScene = {
    glsl: {
      body: "",
      glsl3: false,
      headerVersion: SCENE_HEADER_VERSION,
      textures: [
        { name: "u_plate", source: "plate" as const },
        { name: "u_plateBackground", source: "plate-background" as const },
      ],
    },
    id: "033.0.1O",
    kind: "finding" as const,
  };

  test("a finding's plate samplers default to the bundle's durable R2 keys", () => {
    expect(resolveSceneTextures(plateScene, {})).toEqual({
      u_plate: "https://found.fluncle.com/033.0.1O/plate.png",
      u_plateBackground: "https://found.fluncle.com/033.0.1O/plate.background.png",
    });
  });

  test("explicit plate URLs override the bundle defaults", () => {
    expect(
      resolveSceneTextures(plateScene, {
        plateBackgroundUrl: "https://local/bg.png",
        plateUrl: "https://local/plate.png",
      }),
    ).toEqual({
      u_plate: "https://local/plate.png",
      u_plateBackground: "https://local/bg.png",
    });
  });

  test("artwork samplers bind the artworkUrl; unresolvable entries are omitted", () => {
    const scene = {
      glsl: {
        body: "",
        glsl3: false,
        headerVersion: SCENE_HEADER_VERSION,
        textures: [{ name: "art", source: "artwork" as const }],
      },
      id: "032.0.4L",
      kind: "finding" as const,
    };
    expect(resolveSceneTextures(scene, { artworkUrl: "https://img/cover.jpg" })).toEqual({
      art: "https://img/cover.jpg",
    });
    expect(resolveSceneTextures(scene, {})).toBeUndefined();
  });

  test("a non-finding scene has no bundle to default to (explicit URLs only)", () => {
    const scene = { ...plateScene, kind: "default" as const };
    expect(resolveSceneTextures(scene, {})).toBeUndefined();
    expect(resolveSceneTextures(scene, { plateUrl: "https://local/plate.png" })).toEqual({
      u_plate: "https://local/plate.png",
    });
  });

  test("a texture-less scene stays undefined", () => {
    expect(
      resolveSceneTextures(
        {
          glsl: { body: "", glsl3: false, headerVersion: SCENE_HEADER_VERSION },
          id: "032.0.4L",
          kind: "finding",
        },
        { artworkUrl: "https://img/cover.jpg" },
      ),
    ).toBeUndefined();
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

  test("a composition's hard-coded paletteStops win over the artwork palette", () => {
    // A COOL artwork palette (props) with a WARM hard-coded composition — the 026.4.0E
    // divergence. The emitted scene must carry the WARM rendered stops so a replay
    // re-tints the world the way the shipped footage looks, not the cool artwork.
    const artwork: [string, string, string, string] = ["#0a0f14", "#2f5d6b", "#4a8ea3", "#dfeaf0"];
    const { scene, warnings } = buildScene({
      at,
      glsl: GLSL_FIXTURE,
      grainFamily: "grainChemicalDye",
      id: "026.4.0E",
      kind: "finding",
      metricsReport: null,
      palette: artwork,
      source: RETINT_STOPS_SOURCE,
    });
    expect(scene?.palette).toEqual(["#0e0a06", "#7c391a", "#e59a3f", "#f3e7cf"]);
    // A cleanly resolved override is NOT a divergence — no fallback warning.
    expect(warnings.some((w) => w.includes("DIVERGE"))).toBe(false);
  });

  test("an unresolvable paletteStops override records props + warns of the divergence risk", () => {
    const source = [
      "const FRAG = `void main(){ gl_FragColor = vec4(u_palette[0], 1.0); }`;",
      "<ShaderLayer fragmentShader={FRAG} paletteStops={computeStops(track)} />",
    ].join("\n");
    const { scene, warnings } = buildScene({
      at,
      glsl: GLSL_FIXTURE,
      grainFamily: "grainChemicalDye",
      id: "099.9.9Z",
      kind: "finding",
      metricsReport: null,
      palette,
      source,
    });
    expect(scene?.palette).toEqual(palette);
    expect(warnings.some((w) => w.includes("DIVERGE"))).toBe(true);
  });

  test("a composition with no palette override records the props (artwork) palette, no warning", () => {
    const { scene, warnings } = buildScene({
      at,
      glsl: GLSL_FIXTURE,
      grainFamily: "grainChemicalDye",
      id: "032.0.4L",
      kind: "finding",
      metricsReport: null,
      palette,
      source: LIVE_READY_SOURCE,
    });
    expect(scene?.palette).toEqual(palette);
    expect(warnings.some((w) => w.includes("DIVERGE"))).toBe(false);
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
