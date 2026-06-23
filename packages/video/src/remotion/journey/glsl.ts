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

/** dotField(uv, res, cells, radius, jitter, seed)->0..1: a DENSE anti-aliased
 * stipple / particle screen — the fix for a flock/swarm that comes out sparse.
 * `cells` jittered points across the frame HEIGHT (square cells); returns soft
 * coverage of THIS pixel by its nearest dot, searched over the 3x3 neighbourhood
 * so dots never clip at cell edges or read as a lattice. AA is a fixed ~1.5px
 * (no `fwidth` — WebGL1-safe). radius is in fraction-of-height units: keep it
 * ≥ ~0.0015 (≈3px at 1920) so dots survive h264, and ≈0.3–0.6 × (1/cells) for a
 * clean stipple. Density is the CELL COUNT, not the radius: a real flock is
 * HUNDREDS of cells (≈150–350), not ~100 — and `max()` two octaves with
 * different seeds for sub-grid density. Multiply the result by your OWN density
 * mask + membership so the dots form a BODY, never confetti. Needs `hash`. */
const dotField = /* glsl */ `
float dotField(vec2 uv, vec2 res, float cells, float radius, float jitter, float seed) {
  float asp = res.x / res.y;
  vec2 g = vec2(uv.x * asp, uv.y) * cells;   // square cells, \`cells\` across the height
  vec2 id = floor(g);
  vec2 fp = fract(g);
  float aa = 1.5 / res.y;                     // ~1.5px soft edge (no fwidth; WebGL1-safe)
  float jClamp = clamp(jitter, 0.0, 1.0);
  float cov = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 jit = (hash22(id + o + seed) - 0.5) * jClamp;
      vec2 c = o + 0.5 + jit;                 // the dot centre in cell units, from id
      float d = length(fp - c) / cells;       // distance to that centre, in height-fraction
      cov = max(cov, 1.0 - smoothstep(radius - aa, radius + aa, d));
    }
  }
  return cov;
}`;

/** filmGrain: organic clumping grain (not TV static). Two overloads (GLSL arity
 * overload), both needing `valueNoise`+`hash`:
 *  - filmGrain(col, uv, time, float intensity) — the LEGACY default, unchanged:
 *    today's 1px / 24Hz / monochrome / isotropic emulsion. The ~20 call sites
 *    and every doc snippet keep compiling untouched.
 *  - filmGrain(col, uv, time, GrainOpts o)      — the full knob set, so a
 *    composition picks a grain FAMILY (scale/boil/clump/aniso/color/basis) and an
 *    AMOUNT (`o.amount`; bias LOW toward near-silent — the grain signature stays present every frame, never fully off). Grab a
 *    GRAIN.* preset (the `grainFamilies` snippet) and pass it, or tweak a field:
 *    `GrainOpts o = grainCoarseSilver(); o.amount = 0.04;`.
 * Determinism: a pure function of (uv, floor(time*boilHz), seed) — `boilHz=0`
 * freezes the plate and is still deterministic; basis 3 (blue-noise) is analytic
 * (interleaved-gradient), never a sampled random texture; derive `seed` from
 * `u_seed` for a per-track-stable field. Encode note: COARSER grain (`scale>1`)
 * compresses BETTER than 1px speckle under the README's 32M VBV cap; very fine +
 * heavy is the worst case, so don't crank fine+high. */
const filmGrain = /* glsl */ `
struct GrainOpts {
  float amount;     // master strength, 0.0..0.30; bias LOW (near-silent), never fully off
  float scale;      // grain cell size in px, 0.5..6.0; 1.0 = today's per-pixel speckle
  float boilHz;     // reseed/boil rate, 0.0..30.0; 24.0 = today; 0.0 = frozen plate
  float clumpScale; // clump envelope cell size in px, 8..64; ~22 today
  float clumpAmt;   // 0..1 how strongly clumps pool the speckle; 1 = today, 0 = even film
  vec2  aniso;      // grain stretch; (1,1) isotropic; (1,3) vertical streak (VHS lean)
  float color;      // 0 monochrome (today) .. 1 per-channel RGB (dye-cloud) grain
  float lumaLow;    // shadow grain strength (1.3 today)
  float lumaHigh;   // highlight grain strength (0.55 today)
  int   basis;      // 0 hash, 1 soft, 2 ordered-dither, 3 blue-noise, 4 halftone-dot
  float seed;       // grain field offset; derive from u_seed for per-track stability
};
// recursive ordered (Bayer) dither — array-free, WebGL1-safe, returns ~[0,1).
float grainBayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float grainBayer4(vec2 a) { return grainBayer2(0.5 * a) * 0.25 + grainBayer2(a); }
float grainBayer8(vec2 a) { return grainBayer4(0.5 * a) * 0.25 + grainBayer2(a); }
// interleaved-gradient (blue-noise-ish) value, analytic — returns ~[0,1).
float grainIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// One centered speckle in ~[-0.5,0.5] for a given basis, grain cell, and reseed.
float grainSpeckle(vec2 cell, vec2 g, float t, float seed, int basis) {
  if (basis == 1) {
    // soft: low-freq smooth noise, gentler than per-pixel hash (dye/emulsion bloom).
    return valueNoise(g * 0.5 + t * 1.7 + seed) - 0.5;
  } else if (basis == 2) {
    // ordered dither used AS the grain (a visible 1-bit-ish quantization texture).
    return grainBayer8(cell + floor(vec2(t * 1.7 + seed))) - 0.5;
  } else if (basis == 3) {
    // blue-noise-ish: even, high-frequency dispersion, no clumpy lattice.
    return grainIGN(cell + vec2(t * 1.7 + seed)) - 0.5;
  } else if (basis == 4) {
    // halftone dot screen (rotated ~15deg) — a printed-dot degradation grade;
    // a faint hash boil keeps the print alive frame-to-frame (the signature).
    float c = cos(0.26); float s = sin(0.26);
    vec2 q = mat2(c, -s, s, c) * (g * 0.5);
    float d = length(fract(q) - 0.5);
    float boil = (hash21(cell + t * 1.7 + seed) - 0.5) * 0.25;
    return (0.5 - smoothstep(0.18, 0.32, d)) + boil;
  }
  // basis 0 (default): fine per-pixel hash speckle (today).
  return hash21(cell + t * 1.7 + seed) - 0.5;
}
vec3 filmGrain(vec3 col, vec2 uv, float time, GrainOpts o) {
  // Organic emulsion grain generalized: same clump-pooled, luminance-shaped,
  // integer-time-reseeded speckle as the legacy path, with the character (size,
  // boil, clump, anisotropy, color, basis, amount) exposed as composition knobs.
  float t = floor(time * max(o.boilHz, 0.0));
  vec2 px = uv * u_res;
  // grain cells: scaled (coarse silver vs fine emulsion) + anisotropic (streak).
  vec2 g = px / max(o.scale, 0.001) / max(o.aniso, vec2(0.001));
  vec2 cell = floor(g);
  // clumping envelope on UNSCALED pixels, so clump size is independent of scale.
  float clump = valueNoise(px / max(o.clumpScale, 1.0) + t * 0.31 + o.seed);
  float pooled = mix(0.35, 1.5, clump * clump);
  float envelope = mix(1.0, pooled, clamp(o.clumpAmt, 0.0, 1.0));
  // luminance shaping (mid/shadow grain reads strongest on film).
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  float shape = mix(o.lumaLow, o.lumaHigh, smoothstep(0.0, 0.85, l));
  float mono = grainSpeckle(cell, g, t, o.seed, o.basis) * envelope;
  vec3 grain = vec3(mono);
  if (o.color > 0.001) {
    // per-channel RGB grain (dye-cloud): an independent field per channel.
    vec3 perCh = vec3(
      grainSpeckle(cell, g, t, o.seed, o.basis),
      grainSpeckle(cell, g, t, o.seed + 17.3, o.basis),
      grainSpeckle(cell, g, t, o.seed + 41.7, o.basis)
    ) * envelope;
    grain = mix(vec3(mono), perCh, clamp(o.color, 0.0, 1.0));
  }
  return col + grain * o.amount * shape;
}
// Legacy overload (unchanged): today's 1px / 24Hz / monochrome / isotropic grain.
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

/** grainFamilies: six named GrainOpts presets layered on the filmGrain knob set —
 * `grainFineEmulsion` (today, but amount is yours), `grainCoarseSilver` (pushed
 * high-ISO B&W), `grainHalftone` (printed dot screen), `grainChemicalDye` (the
 * one on-brand COLORED grain), `grainVhsScanline` (anisotropic tape streak),
 * `grainDither` (visible ordered-dither grade). Pass one straight into the
 * GrainOpts overload of `filmGrain`, or grab and tweak a field. Each video picks
 * a DISTINCT family (the grain diversity ledger). Needs `filmGrain` (the
 * GrainOpts struct) and the injected `u_seed`. SET amount to the composition —
 * often BELOW the 0.08 default; a clean, electric finding wants its pop. */
const grainFamilies = /* glsl */ `
GrainOpts grainFineEmulsion() {
  return GrainOpts(0.08, 1.0, 24.0, 22.0, 1.0, vec2(1.0), 0.0, 1.3, 0.55, 0, u_seed);
}
GrainOpts grainCoarseSilver() {
  return GrainOpts(0.07, 3.2, 11.0, 30.0, 1.0, vec2(1.0), 0.0, 1.35, 0.5, 0, u_seed);
}
GrainOpts grainHalftone() {
  return GrainOpts(0.10, 2.4, 18.0, 28.0, 0.6, vec2(1.0), 0.0, 1.2, 0.6, 4, u_seed);
}
GrainOpts grainChemicalDye() {
  return GrainOpts(0.07, 1.4, 20.0, 34.0, 0.8, vec2(1.0), 1.0, 1.2, 0.6, 1, u_seed);
}
GrainOpts grainVhsScanline() {
  return GrainOpts(0.08, 1.2, 28.0, 26.0, 0.5, vec2(1.0, 3.0), 0.25, 1.2, 0.65, 0, u_seed);
}
GrainOpts grainDither() {
  return GrainOpts(0.09, 1.6, 10.0, 24.0, 0.4, vec2(1.0), 0.0, 1.1, 0.7, 2, u_seed);
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

/** curlNoise(p)->vec2: divergence-free 2D flow direction from a valueNoise
 * potential — organic swirling advection for flocks, smoke, particle drift (the
 * fluid/alive north star). Scale `p` for frequency, multiply the result for
 * strength, advect a coordinate by it over u_time. Needs `valueNoise`. */
const curlNoise = /* glsl */ `
vec2 curlNoise(vec2 p) {
  float e = 0.01;
  float dPdy = (valueNoise(p + vec2(0.0, e)) - valueNoise(p - vec2(0.0, e))) / (2.0 * e);
  float dPdx = (valueNoise(p + vec2(e, 0.0)) - valueNoise(p - vec2(e, 0.0))) / (2.0 * e);
  return vec2(dPdy, -dPdx);
}`;

/** domainWarp(p, octaves)->0..1: fbm of fbm-warped coordinates (the IQ domain
 * warp) — marbled, flowing, never-gridded fields. Needs `fbm`. */
const domainWarp = /* glsl */ `
float domainWarp(vec2 p, int octaves) {
  vec2 q = vec2(fbm(p, octaves), fbm(p + vec2(5.2, 1.3), octaves));
  vec2 r = vec2(
    fbm(p + 4.0 * q + vec2(1.7, 9.2), octaves),
    fbm(p + 4.0 * q + vec2(8.3, 2.8), octaves)
  );
  return fbm(p + 4.0 * r, octaves);
}`;

/** voronoi(p)->vec3: cellular / worley noise. x = F1 (distance to nearest cell
 * point), y = F2 (second-nearest), z = cell hash 0..1. Cell WALLS = smoothstep
 * on (F2 - F1); cracked glaze, dry lakebed, breathing cells. Needs `hash`. */
const voronoi = /* glsl */ `
vec3 voronoi(vec2 p) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = hash21(n + g); }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}`;

/** sdf3d: 3D signed-distance primitives + rot2 for raymarched/volumetric scenes
 * — sdSphere3 / sdBox3 / sdTorus3. Combine with `smin` (from `sdf`) for smooth
 * unions; pair with `raymarch`. Self-contained. */
const sdf3d = /* glsl */ `
float sdSphere3(vec3 p, float r) { return length(p) - r; }
float sdBox3(vec3 p, vec3 b) {
  vec3 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
}
float sdTorus3(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}
mat2 rot2(float a) { float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }`;

/** raymarch: a sphere-tracer + gradient normal for 3D/volumetric scenes. You
 * MUST define \`float map(vec3 p)\` in your shader (it is forward-declared here);
 * build it from `sdf3d` primitives. raymarch(ro, rd, tmax)->hit distance;
 * calcNormal(p)->vec3. Keep it modest — this runs per pixel; soften the result
 * with grain so it never reads as clean CGI (the Light-Years Rule). */
const raymarch = /* glsl */ `
float map(vec3 p);
float raymarch(vec3 ro, vec3 rd, float tmax) {
  float t = 0.0;
  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);
    if (d < 0.001 || t > tmax) { break; }
    t += d;
  }
  return t;
}
vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)
  ));
}`;

/**
 * The GLSL snippet library. Spread the strings you need into a fragment shader
 * ahead of `void main()`. Mind dependencies: `valueNoise`/`simplexNoise` need
 * `hash`; `fbm` needs `valueNoise`; `filmGrain` needs `valueNoise`+`hash`.
 */
export const GLSL = {
  /** Per-channel UV offset helpers for an edge-growing RGB chromatic split. */
  chromaticAberration,
  /** Divergence-free 2D flow field curlNoise(p)->vec2 (organic advection). Needs valueNoise. */
  curlNoise,
  /** IQ domain warp domainWarp(p, octaves)->0..1 (marbled flowing fields). Needs fbm. */
  domainWarp,
  /** Dense AA stipple/particle screen dotField(uv,res,cells,radius,jitter,seed)->0..1. Needs hash. */
  dotField,
  /** Fractal brownian motion fbm(p, octaves)->0..1 (domain-rotated). Needs valueNoise. */
  fbm,
  /** Organic emulsion-clumping film grain. Two overloads: filmGrain(col,uv,time,float) (legacy) + filmGrain(col,uv,time,GrainOpts) (full knob set, amount→0=off). Needs valueNoise+hash. */
  filmGrain,
  /** Six named GrainOpts presets (fineEmulsion/coarseSilver/halftone/chemicalDye/vhsScanline/dither) for the filmGrain knob set. Needs filmGrain + u_seed. */
  grainFamilies,
  /** Deterministic value hashes: hash21, hash22, hash13. Base for all noise. */
  hash,
  /** The Retint gradient-map paletteRamp(t)->vec3 + retint(src) over u_palette. */
  paletteRamp,
  /** Kaleidoscope wedge fold polarFold(uv, segments)->vec2 around center. */
  polarFold,
  /** Sphere-tracer raymarch(ro,rd,tmax) + calcNormal(p); define your own float map(vec3). */
  raymarch,
  /** Signed-distance primitives sdCircle/sdBox + smooth union smin. */
  sdf,
  /** 3D SDF primitives sdSphere3/sdBox3/sdTorus3 + rot2, for raymarched scenes. */
  sdf3d,
  /** Gradient (simplex-style) noise simplexNoise(p)->~-1..1. Needs hash. */
  simplexNoise,
  /** Smooth bilinear value noise valueNoise(p)->0..1. Needs hash. */
  valueNoise,
  /** Radial darkening multiplier vignette(uv, radius, softness)->0..1. */
  vignette,
  /** Cellular/worley voronoi(p)->vec3 (F1, F2, cellHash); walls = smoothstep(F2-F1). Needs hash. */
  voronoi,
} as const;

export type GlslSnippet = keyof typeof GLSL;
