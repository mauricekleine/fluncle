// Composable GLSL snippet library for <ShaderLayer> fragment shaders.
//
// Each export is a string of GLSL functions that an agent interpolates into a
// fragment shader body. ShaderLayer injects a standard header (precision,
// u_time, u_res, u_progress, u_energy, u_bass, u_beatPulse, u_seed,
// u_palette[4], plus a dither() + 8-bit helper); these snippets only add
// functions on top. Compose them like:
//
//   import { GLSL } from "./glsl";
//   const frag = `
//     ${GLSL.noise} ${GLSL.fbm} ${GLSL.paletteRamp} ${GLSL.filmGrain} ${GLSL.vignette}
//     void main() {
//       vec2 uv = gl_FragCoord.xy / u_res;
//       float n = fbm(uv * 3.0 + u_time * 0.1, 5);
//       vec3 col = paletteRamp(n);
//       col = filmGrain(col, uv, u_time, 0.08);
//       col *= vignette(uv, 1.1, 0.6); // GENTLE corner falloff; a tight radius
//                                      // portholes a full-bleed field (quad law)
//       gl_FragColor = vec4(dither8(col, uv), 1.0);
//     }`;
//
// All snippets are deterministic: they read only their args and the injected
// uniforms, never gl_FragCoord-independent state, so a frame is a pure function
// of (uv, u_time, u_seed). u_time/u_progress derive from useCurrentFrame()/fps
// upstream (Remotion determinism). The Retint Rule lives in `paletteRamp`:
// luminance is remapped through the four u_palette stops, recoloring any source
// into the canon. Moodboard: grain-liquid-heat.jpg (grain over gradient),
// phosphor-grain-field.png (dense warm-dark grain), liquid-spectrum-vortex.png
// (engraved line-screen / fbm fields), mirror-quilt-desert.png (polarFold).

/** hash21/hash22/hash33: cheap deterministic value hashes. hash21(vec2)->float. */
const hash = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 78.233);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p) {
  vec3 a = fract(vec3(p.xyx) * vec3(123.34, 234.34, 345.65));
  a += dot(a, a + 34.45);
  return fract(vec2(a.x * a.y, a.y * a.z));
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}`;

/** valueNoise(vec2)->0..1: smooth bilinear value noise. Needs `hash`. */
const valueNoise = /* glsl */ `
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`;

/** simplexNoise(vec2)->~-1..1: gradient (simplex-style) noise. Needs `hash`. */
const simplexNoise = /* glsl */ `
float simplexNoise(vec2 p) {
  const float K1 = 0.366025404; // (sqrt(3)-1)/2
  const float K2 = 0.211324865; // (3-sqrt(3))/6
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  float m = step(a.y, a.x);
  vec2 o = vec2(m, 1.0 - m);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 g = vec3(
    dot(a, hash22(i) * 2.0 - 1.0),
    dot(b, hash22(i + o) * 2.0 - 1.0),
    dot(c, hash22(i + 1.0) * 2.0 - 1.0)
  );
  vec3 n = h * h * h * h * g;
  return dot(n, vec3(70.0));
}`;

/** fbm(vec2 p, int octaves)->0..1: fractal brownian motion. Needs `valueNoise`. */
const fbm = /* glsl */ `
float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8); // domain rotation kills axis-aligned grid
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * valueNoise(p);
    norm += amp;
    p = rot * p * 2.0 + 11.7;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}`;

/** paletteRamp(float t)->vec3: the Retint gradient-map; remaps 0..1 through u_palette[0..3]. */
const paletteRamp = /* glsl */ `
vec3 paletteRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  float s = t * 3.0; // four stops -> three segments
  if (s < 1.0) return mix(u_palette[0], u_palette[1], smoothstep(0.0, 1.0, s));
  if (s < 2.0) return mix(u_palette[1], u_palette[2], smoothstep(0.0, 1.0, s - 1.0));
  return mix(u_palette[2], u_palette[3], smoothstep(0.0, 1.0, s - 2.0));
}
// Retint Rule helper: collapse any source color to luminance, then ramp it.
vec3 retint(vec3 src) {
  float l = dot(src, vec3(0.299, 0.587, 0.114));
  return paletteRamp(l);
}`;

/** polarFold(vec2 uv, float segments)->vec2: kaleidoscope wedge fold around (0.5,0.5). */
const polarFold = /* glsl */ `
vec2 polarFold(vec2 uv, float segments) {
  vec2 p = uv - 0.5;
  float a = atan(p.y, p.x);
  float r = length(p);
  float seg = 6.2831853 / segments;
  a = mod(a, seg);
  a = abs(a - seg * 0.5); // mirror within the wedge for clean kaleido seams
  return vec2(cos(a), sin(a)) * r + 0.5;
}`;

/** sdBox/sdCircle + smin: signed-distance primitives and smooth union for SDF scenes. */
const sdf = /* glsl */ `
float sdCircle(vec2 p, float r) {
  return length(p) - r;
}
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
// Polynomial smooth minimum: k controls the blend radius of the union.
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}`;

/** filmGrain(vec3 col, vec2 uv, float time, float intensity)->vec3: organic clumping grain (not TV static). Needs `valueNoise`+`hash`. */
const filmGrain = /* glsl */ `
vec3 filmGrain(vec3 col, vec2 uv, float time, float intensity) {
  // Organic emulsion grain, NOT TV static. Three things make it read as film:
  // (1) the speckle is fine but its AMPLITUDE is modulated by a low-frequency
  // noise envelope, so grain pools into clumps and clears in patches the way
  // emulsion does; (2) it reseeds on an integer time slice so it crawls without
  // strobing; (3) it is luminance-shaped, strongest in the mids/shadows.
  float t = floor(time * 24.0);
  vec2 g = uv * u_res;
  // Fine speckle: per-pixel hash, the actual grain.
  float speckle = hash21(floor(g) + t * 1.7) - 0.5;
  // Clumping envelope: smooth low-freq noise (~24px cells) that swells and
  // suppresses the speckle locally, giving emulsion-like clusters.
  float clump = valueNoise(g * 0.045 + t * 0.31);
  float envelope = mix(0.35, 1.5, clump * clump);
  float grain = speckle * envelope;
  // Tie grain strength to luminance (mid/shadow grain reads strongest on film).
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  float shape = mix(1.3, 0.55, smoothstep(0.0, 0.85, l));
  return col + grain * intensity * shape;
}`;

/** vignette(vec2 uv, float radius, float softness)->0..1: radial darkening multiplier.
 * On a FULL-BLEED field keep it GENTLE (radius ≳ 1.0): a tight radius darkens the
 * corners into a circular porthole that crops the 9:16 frame (the quad law warns
 * of this). Reserve aggressive radial falloff for a localized layer, not the bg. */
const vignette = /* glsl */ `
float vignette(vec2 uv, float radius, float softness) {
  float d = distance(uv, vec2(0.5));
  return smoothstep(radius, radius - softness, d);
}`;

/** caOffset(vec2 uv, float amount)->vec3 r/g/b offsets along view; sample each channel offset for chromatic aberration. */
const chromaticAberration = /* glsl */ `
// Returns per-channel UV offsets radiating from center; use to sample a texture
// (or re-evaluate a field) three times for an RGB split that grows toward edges.
// Moodboard: concentric-stripe-moire.png (chromatic split on hard edges).
vec2 caOffsetR(vec2 uv, float amount) { return (uv - 0.5) * amount + uv; }
vec2 caOffsetB(vec2 uv, float amount) { return (uv - 0.5) * -amount + uv; }`;

/**
 * The GLSL snippet library. Spread the strings you need into a fragment shader
 * ahead of `void main()`. Mind dependencies: `valueNoise`/`simplexNoise` need
 * `hash`; `fbm` needs `valueNoise`; `filmGrain` needs `valueNoise`+`hash`.
 */
export const GLSL = {
  /** Per-channel UV offset helpers for an edge-growing RGB chromatic split. */
  chromaticAberration,
  /** Fractal brownian motion fbm(p, octaves)->0..1 (domain-rotated). Needs valueNoise. */
  fbm,
  /** Organic emulsion-clumping film grain filmGrain(col, uv, time, intensity). Needs valueNoise+hash. */
  filmGrain,
  /** Deterministic value hashes: hash21, hash22, hash13. Base for all noise. */
  hash,
  /** The Retint gradient-map paletteRamp(t)->vec3 + retint(src) over u_palette. */
  paletteRamp,
  /** Kaleidoscope wedge fold polarFold(uv, segments)->vec2 around center. */
  polarFold,
  /** Signed-distance primitives sdCircle/sdBox + smooth union smin. */
  sdf,
  /** Gradient (simplex-style) noise simplexNoise(p)->~-1..1. Needs hash. */
  simplexNoise,
  /** Smooth bilinear value noise valueNoise(p)->0..1. Needs hash. */
  valueNoise,
  /** Radial darkening multiplier vignette(uv, radius, softness)->0..1. */
  vignette,
} as const;

export type GlslSnippet = keyof typeof GLSL;
