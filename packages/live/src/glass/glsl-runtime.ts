// The shared GLSL runtime — the constants the server-side extractor and the
// client renderer both build on. Split out of the v0.6 monolith so the header
// contract (CORE_UNIFORMS) lives in exactly one place. Imports the REAL
// packages/video vocabulary (zero duplication); the relative path keeps the
// package portable (the seed's absolute /Users path is gone).
import { GLSL } from "../../../video/src/remotion/journey/glsl.ts";

// The header uniform names the live glass injects (must match CORE_UNIFORMS in
// packages/video/src/remotion/journey/shader-layer.tsx). A `uniform` a replayed
// body declares that is NOT in this set is a CUSTOM uniform (a journey helper).
export const HEADER_UNIFORMS = new Set([
  "u_time",
  "u_res",
  "u_progress",
  "u_energy",
  "u_bass",
  "u_mid",
  "u_treble",
  "u_beatPulse",
  "u_onsetPulse",
  "u_audioHit",
  "u_audioSwell",
  "u_audioDrop",
  "u_audioDisturbance",
  "u_energyFast",
  "u_bassFast",
  "u_midFast",
  "u_trebleFast",
  "u_flux",
  "u_sub",
  "u_kickHit",
  "u_snareHit",
  "u_air",
  "u_downbeatPulse",
  "u_seed",
  "u_palette",
]);

// The exact core-uniform + dither block ShaderLayer injects, so a replay program
// compiles the archived body byte-for-byte the way the offline render did.
export const CORE_UNIFORMS_GLSL = `uniform float u_time;
uniform vec2  u_res;
uniform float u_progress;
uniform float u_energy;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_beatPulse;
uniform float u_onsetPulse;
uniform float u_audioHit;
uniform float u_audioSwell;
uniform float u_audioDrop;
uniform float u_audioDisturbance;
uniform float u_energyFast;
uniform float u_bassFast;
uniform float u_midFast;
uniform float u_trebleFast;
uniform float u_flux;
uniform float u_sub;
uniform float u_kickHit;
uniform float u_snareHit;
uniform float u_air;
uniform float u_downbeatPulse;
uniform float u_seed;
uniform vec3  u_palette[4];`;

export const DITHER_HELPERS_GLSL = `float ditherValue(vec2 fragCoord) {
  vec2 p = fract(fragCoord * vec2(0.7548776662, 0.5698402909));
  float n = fract(p.x * p.y * 437.585453);
  return (n - 0.5) / 255.0;
}
vec3 dither8(vec3 col, vec2 uv) {
  return col + ditherValue(uv * u_res);
}`;

// The header prepended to a replay body client-side to form the full fragment.
// A replay layer may declare EXTRA custom uniforms after this header (the extractor
// leaves them in the body) — they are set per their classified journey role.
export const REPLAY_HEADER = `precision highp float;\n${CORE_UNIFORMS_GLSL}\n\n${DITHER_HELPERS_GLSL}\n\n`;

/** The fullscreen-triangle vertex shader shared by every program (base + replay + bloom). */
export const VERT = "attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }";

// The default-vehicle world (uncharted space + the tag-mapped fallback + holding).
// Three vehicles crossfaded on u_scene, plus the canon holding scene on u_holding.
export const FRAG = /* glsl */ `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_energy;
uniform float u_kickHit;
uniform float u_swell;
uniform float u_scene;   // 0..2 continuous — crossfades the three vehicles
uniform float u_holding; // 0..1 — crossfades the whole field toward the holding scene
uniform float u_seed;    // 0..1 normalized finding seed — offsets the world per arrival
uniform vec3 u_palette[4];

${GLSL.hash}
${GLSL.valueNoise}
${GLSL.caustic}
${GLSL.neuroWeb}
${GLSL.noise3}
${GLSL.oklab}
${GLSL.filmGrain}

// Vehicle 0: the caustic wall — refracted light, scale breathes on the swell,
// brightness flinches on the kick (in place — the Motion law survives live).
vec3 sceneCaustic(vec2 p, float t) {
  float c = caustic(p * (2.2 + 0.6 * u_swell), t * 0.22 + 7.0, 3.0, 6);
  float lit = clamp(pow(c * 0.42, 2.2) * (0.35 + 0.55 * u_bass + 0.45 * u_kickHit), 0.0, 0.9);
  return paletteRampOk(lit);
}

// Vehicle 1: the neuro web — filament contrast on the kick, glow on the mids.
vec3 sceneNeuro(vec2 p, float t) {
  float n = neuroWeb(p * 1.4, t * 0.25, 15);
  float lit = clamp(n * n * (0.28 + 0.4 * u_mid + 0.35 * u_kickHit), 0.0, 0.9);
  return paletteRampOk(pow(lit, 1.15 + 0.8 * (1.0 - u_energy)));
}

// Vehicle 2: the fbm3 roil — a field that re-forms in place on the z-phase,
// density gated by the energy envelope, treble sparkles the fine detail.
vec3 sceneRoil(vec2 p, float t) {
  float n = fbm3(vec3(p * 2.4, t * 0.13), 5);
  float ridges = pow(1.0 - abs(2.0 * n - 1.0), 2.6);
  float thr = mix(0.62, 0.42, clamp(u_swell * 0.8 + u_energy * 0.4, 0.0, 1.0));
  float w = 0.14 + u_bass * 0.12 + u_treble * 0.06;
  float fil = smoothstep(thr, thr + w, ridges);
  return paletteRampOk(clamp(fil * (0.4 + 0.35 * u_kickHit + 0.2 * u_energy), 0.0, 0.85));
}

// The canon HOLDING scene (RFC §2). Warm Dark ground + a slow boiling grain-field,
// a beat-clock-only ambient pulse on the swell, and NO gold — the single terminal
// rest state (blackout target, silence target, flash-limiter trip target, key 0).
vec3 sceneHolding(vec2 p, float t) {
  float n = fbm3(vec3(p * 1.5, t * 0.045), 4);
  float boil = 0.028 + 0.06 * u_swell * (0.5 + 0.5 * n);
  vec3 g = u_palette[0];
  return g + vec3(boil, boil * 0.82, boil * 0.68);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  p += vec2(u_seed * 7.0, u_seed * 11.0);
  float t = u_time + u_seed * 40.0;

  float s = u_scene;
  float w0 = clamp(1.0 - abs(s - 0.0), 0.0, 1.0);
  float w1 = clamp(1.0 - abs(s - 1.0), 0.0, 1.0);
  float w2 = clamp(1.0 - abs(s - 2.0), 0.0, 1.0);
  w0 += clamp(1.0 - abs(s - 3.0), 0.0, 1.0);

  vec3 col = vec3(0.0);
  if (w0 > 0.001) col += w0 * sceneCaustic(p, t);
  if (w1 > 0.001) col += w1 * sceneNeuro(p, t);
  if (w2 > 0.001) col += w2 * sceneRoil(p, t);

  if (u_holding > 0.001) col = mix(col, sceneHolding(p, t), u_holding);

  // RAIL 1 — Warm Dark output clamp.
  col = min(col, vec3(0.92));
  // RAIL 2 — the Light-Years grade: a gentle emulsion boil, grain floor always present.
  col = filmGrain(col, uv, u_time, 0.05);
  gl_FragColor = vec4(col, 1.0);
}
`;

// --- Bloom post-pass (RFC §3 / Unit L item 2) --------------------------------
// A shared bright-pass -> separable half-res blur -> additive composite chain,
// mirroring packages/video/src/remotion/journey/shader-layer.tsx's bloom design
// (same threshold/intensity/radius semantics). Applied to replayed scenes whose
// plan entry carries bloom config, and to the default vehicles at tasteful defaults.

export const BLOOM_BRIGHT_FRAG = `precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_threshold;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 c = texture2D(u_tex, uv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float k = smoothstep(u_threshold, u_threshold + 0.25, l);
  gl_FragColor = vec4(c * k, 1.0);
}`;

export const BLOOM_BLUR_FRAG = `precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec2 u_dir;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 px = u_dir / u_res;
  vec3 sum = texture2D(u_tex, uv).rgb * 0.227027;
  sum += texture2D(u_tex, uv + px * 1.3846).rgb * 0.316216;
  sum += texture2D(u_tex, uv - px * 1.3846).rgb * 0.316216;
  sum += texture2D(u_tex, uv + px * 3.2307).rgb * 0.070270;
  sum += texture2D(u_tex, uv - px * 3.2307).rgb * 0.070270;
  gl_FragColor = vec4(sum, 1.0);
}`;

export const BLOOM_COMPOSITE_FRAG = `precision highp float;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform vec2 u_res;
uniform float u_intensity;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec4 scene = texture2D(u_scene, uv);
  vec3 bloom = texture2D(u_bloom, uv).rgb;
  gl_FragColor = vec4(scene.rgb + bloom * u_intensity, scene.a);
}`;

// A trivial passthrough used to blit an FBO texture to the screen/next FBO.
export const BLIT_FRAG = `precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  gl_FragColor = texture2D(u_tex, uv);
}`;

export type BloomConfig = { threshold: number; intensity: number; radius: number };
export const DEFAULT_BLOOM: BloomConfig = { intensity: 0.35, radius: 1, threshold: 0.78 };
