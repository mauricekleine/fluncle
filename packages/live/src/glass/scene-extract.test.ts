// Scene-extraction proof. Synthetic compositions exercise every replay path:
// single-layer, the two closed gaps (multi-layer composite + velocity-pair
// integration), and the four rejections (lone vec2 motion, texture, non-GLSL
// interpolation, DOM-only). The real 011.9.8I / 011.1.3X bodies are validated
// out-of-band (see the PR notes); these keep the classifier honest deterministically.

import { describe, expect, test } from "bun:test";
import {
  extractScene,
  extractTextureSources,
  resolveSceneTextureUrls,
  resolveTextureUrl,
} from "./scene-extract.ts";

const single = `
import { ShaderLayer } from "@fluncle/video";
const FRAG = /* glsl */ \`
\${GLSL.fbm}
uniform float u_arc;
uniform float u_swell;
uniform vec3 u_glowColor;
void main() {
  float n = fbm(gl_FragCoord.xy / u_res, 5) * u_arc * u_swell;
  gl_FragColor = vec4(u_glowColor * n, 1.0);
}\`;
export const C = () => (<ShaderLayer fragmentShader={FRAG} bloom={{ threshold: 0.6, intensity: 0.9, radius: 2 }} />);
`;

const multi = `
const WATER = /* glsl */ \`
\${GLSL.noise3}
void main() { gl_FragColor = vec4(vec3(0.1), 1.0); }\`;
const BLOOM = /* glsl */ \`
\${GLSL.hash}
uniform float u_core;
void main() { gl_FragColor = vec4(vec3(u_core), 0.6); }\`;
export const C = () => (
  <AbsoluteFill>
    <ShaderLayer fragmentShader={WATER} />
    <ShaderLayer fragmentShader={BLOOM} uniforms={{ u_core: reactivity.drop }} />
  </AbsoluteFill>
);
`;

const velocity = `
const VEIL = /* glsl */ \`
\${GLSL.fbm}
uniform float u_flow;
uniform float u_flowVel;
uniform vec2  u_glide;
uniform vec2  u_glideVel;
void main() {
  vec2 g = u_glide - u_glideVel * 0.5;
  gl_FragColor = vec4(vec3(fbm(g + u_flow, 4)), 1.0);
}\`;
export const C = () => (<ShaderLayer fragmentShader={VEIL} uniforms={{ u_flow: flow, u_flowVel: flowVel, u_glide: glide, u_glideVel: glideVel }} />);
`;

const loneVec2 = `
const F = /* glsl */ \`
uniform vec2 u_drift;
void main() { gl_FragColor = vec4(vec3(u_drift.x), 1.0); }\`;
export const C = () => (<ShaderLayer fragmentShader={F} />);
`;

const textured = `
const F = /* glsl */ \`
uniform sampler2D u_art;
void main() { gl_FragColor = texture2D(u_art, gl_FragCoord.xy / u_res); }\`;
export const C = () => (<ShaderLayer fragmentShader={F} />);
`;

const nonGlsl = `
const F = /* glsl */ \`
\${somethingElse}
void main() { gl_FragColor = vec4(1.0); }\`;
export const C = () => (<ShaderLayer fragmentShader={F} />);
`;

const domOnly = `export const C = () => (<AbsoluteFill><Starfield /></AbsoluteFill>);`;

// A real plate-lane composition: the body SAMPLES u_plate / u_plateBackground /
// u_plateAspectRatio but never DECLARES them (the offline ShaderLayer injects the
// header pair); the samplers are supplied through the `textures=` prop. The old
// extractor marked this replayable but the glass never bound the images.
const plate = `
const FRAGMENT = /* glsl */ \`
\${GLSL.fbm}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float a = u_plateAspectRatio;
  vec3 near = texture2D(u_plate, uv * a).rgb;
  vec3 far = texture2D(u_plateBackground, uv).rgb;
  gl_FragColor = vec4(mix(far, near, u_audioSwell), 1.0);
}\`;
export const C = () => (
  <ShaderLayer
    fragmentShader={FRAGMENT}
    bloom={{ threshold: 0.62, intensity: 0.72, radius: 2.4 }}
    textures={{ u_plate: plateUrl, u_plateBackground: bgUrl }}
  />
);
`;

// A single artwork sampler (any name that is not a plate slot → the finding's cover).
const artwork = `
const F = /* glsl */ \`
void main() { gl_FragColor = texture2D(u_art, gl_FragCoord.xy / u_res); }\`;
export const C = () => (<ShaderLayer fragmentShader={F} textures={{ u_art: track.artworkUrl }} />);
`;

describe("single-layer extraction", () => {
  const s = extractScene(single);
  test("is replayable with one layer", () => {
    expect(s.replayable).toBe(true);
    expect(s.layers).toHaveLength(1);
    expect(s.layers[0].blend).toBe("opaque");
    expect(s.body).toContain("void main");
  });
  test("resolves GLSL.* deps into the body (no unresolved template holes)", () => {
    expect(s.body).not.toContain("${");
    expect(s.body).toContain("fbm"); // GLSL.fbm inlined
  });
  test("classifies rise / audio / colour customs", () => {
    const by = Object.fromEntries(s.customUniforms.map((c) => [c.name, c.class]));
    expect(by.u_arc).toBe("riseRamp");
    expect(by.u_swell).toBe("audioAlias");
    expect(by.u_glowColor).toBe("color");
  });
  test("reads the bloom prop", () => {
    expect(s.bloom).toEqual({ intensity: 0.9, radius: 2, threshold: 0.6 });
  });
});

describe("multi-layer composite (the 011.9.8I gap)", () => {
  const s = extractScene(multi);
  test("returns both layers in order", () => {
    expect(s.replayable).toBe(true);
    expect(s.layers).toHaveLength(2);
  });
  test("layer 0 is opaque, layer 1 composites over", () => {
    expect(s.layers[0].blend).toBe("opaque");
    expect(s.layers[1].blend).toBe("over");
  });
  test("each layer keeps its own custom uniforms", () => {
    expect(s.layers[0].customUniforms).toHaveLength(0);
    expect(s.layers[1].customUniforms.map((c) => c.name)).toContain("u_core");
  });
});

describe("velocity-pair integration (the 011.1.3X gap)", () => {
  const s = extractScene(velocity);
  test("is now replayable (the seed rejected all vec2/Vel/glide)", () => {
    expect(s.replayable).toBe(true);
  });
  test("positions are velocityPos, their siblings are velocity", () => {
    const by = Object.fromEntries(s.customUniforms.map((c) => [c.name, c.class]));
    expect(by.u_flow).toBe("velocityPos");
    expect(by.u_flowVel).toBe("velocity");
    expect(by.u_glide).toBe("velocityPos");
    expect(by.u_glideVel).toBe("velocity");
  });
  test("the vec2 position carries its type for the integrator", () => {
    const glide = s.customUniforms.find((c) => c.name === "u_glide");
    expect(glide?.type).toBe("vec2");
  });
});

describe("plate-lane textures (the closed gap: samplers supplied via the textures= prop)", () => {
  const s = extractScene(plate);
  test("is replayable — the plate samplers are loadable, not a rejection", () => {
    expect(s.replayable).toBe(true);
    expect(s.layers).toHaveLength(1);
  });
  test("records both samplers with their sources, mapped by the name convention", () => {
    const by = Object.fromEntries(s.layers[0].textures.map((t) => [t.name, t.source]));
    expect(by.u_plate).toBe("plate");
    expect(by.u_plateBackground).toBe("plate-background");
    expect(s.textures).toHaveLength(2); // scene-level roster (the boot-table count)
  });
  test("the header uniform u_audioSwell is NOT mistaken for a custom uniform", () => {
    expect(s.customUniforms).toHaveLength(0);
  });
  test("still reads the bloom prop alongside the textures", () => {
    expect(s.bloom).toEqual({ intensity: 0.72, radius: 2.4, threshold: 0.62 });
  });
});

describe("artwork sampler (a non-plate name binds the finding's cover)", () => {
  const s = extractScene(artwork);
  test("is replayable with an artwork-source texture", () => {
    expect(s.replayable).toBe(true);
    expect(s.textures).toEqual([{ name: "u_art", source: "artwork" }]);
  });
});

describe("extractTextureSources (the textures= prop parser)", () => {
  test("maps each sampler name to its source via the convention", () => {
    const map = extractTextureSources(plate);
    expect(map.get("u_plate")).toBe("plate");
    expect(map.get("u_plateBackground")).toBe("plate-background");
    expect(map.size).toBe(2);
  });
  test("a comp with no textures= prop yields an empty map", () => {
    expect(extractTextureSources(single).size).toBe(0);
  });
});

describe("resolveTextureUrl (source → concrete URL)", () => {
  test("plate + plate-background resolve to the finding bundle's durable R2 keys", () => {
    expect(resolveTextureUrl("plate", "020.8.6A")).toBe(
      "https://found.fluncle.com/020.8.6A/plate.png",
    );
    expect(resolveTextureUrl("plate-background", "020.8.6A")).toBe(
      "https://found.fluncle.com/020.8.6A/plate.background.png",
    );
  });
  test("a custom base (the FLUNCLE_FOUND_BASE override) is honoured", () => {
    expect(resolveTextureUrl("plate", "027.9.5H", null, "http://localhost:9999")).toBe(
      "http://localhost:9999/027.9.5H/plate.png",
    );
  });
  test("artwork binds the passed cover URL, or resolves to nothing without one", () => {
    expect(resolveTextureUrl("artwork", "x", "https://img/cover.jpg")).toBe(
      "https://img/cover.jpg",
    );
    expect(resolveTextureUrl("artwork", "x")).toBeUndefined();
  });
});

describe("resolveSceneTextureUrls (the enrichment fills every declared sampler's url)", () => {
  test("a plate scene gets concrete plate URLs on both the layer + scene rosters", () => {
    const resolved = resolveSceneTextureUrls(extractScene(plate), "020.8.6A");
    expect(resolved.layers[0].textures.map((t) => t.url)).toEqual([
      "https://found.fluncle.com/020.8.6A/plate.png",
      "https://found.fluncle.com/020.8.6A/plate.background.png",
    ]);
    expect(resolved.textures.every((t) => typeof t.url === "string")).toBe(true);
  });
  test("an artwork sampler with no cover is DROPPED (no broken image bound)", () => {
    const resolved = resolveSceneTextureUrls(extractScene(artwork), "x", null);
    expect(resolved.textures).toHaveLength(0);
    expect(resolved.layers[0].textures).toHaveLength(0);
  });
});

describe("rejections (still not replayable — the free fallback covers them)", () => {
  test("a lone vec2 with no …Vel sibling", () => {
    const s = extractScene(loneVec2);
    expect(s.replayable).toBe(false);
    expect(s.reason).toContain("vec2");
  });
  test("a body-declared sampler with NO textures= prop (no live upload path)", () => {
    const s = extractScene(textured);
    expect(s.replayable).toBe(false);
    expect(s.reason).toContain("texture");
  });
  test("a non-GLSL interpolation", () => {
    const s = extractScene(nonGlsl);
    expect(s.replayable).toBe(false);
    expect(s.reason).toContain("non-GLSL");
  });
  test("a DOM-only composition", () => {
    const s = extractScene(domOnly);
    expect(s.replayable).toBe(false);
    expect(s.layers).toHaveLength(0);
  });
});
