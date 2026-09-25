const hash = `
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

const valueNoise = `
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

const simplexNoise = `
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

const fbm = `
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

const paletteRamp = `
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

const polarFold = `
vec2 polarFold(vec2 uv, float segments) {
  vec2 p = uv - 0.5;
  float a = atan(p.y, p.x);
  float r = length(p);
  float seg = 6.2831853 / segments;
  a = mod(a, seg);
  a = abs(a - seg * 0.5); // mirror within the wedge for clean kaleido seams
  return vec2(cos(a), sin(a)) * r + 0.5;
}`;

const sdf = `
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

const dotField = `
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

const filmGrain = `
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

const grainFamilies = `
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

const vignette = `
float vignette(vec2 uv, float radius, float softness) {
  float d = distance(uv, vec2(0.5));
  return smoothstep(radius, radius - softness, d);
}`;

const chromaticAberration = `
// Returns per-channel UV offsets radiating from center; use to sample a texture
// (or re-evaluate a field) three times for an RGB split that grows toward edges.
// Moodboard: concentric-stripe-moire.png (chromatic split on hard edges).
vec2 caOffsetR(vec2 uv, float amount) { return (uv - 0.5) * amount + uv; }
vec2 caOffsetB(vec2 uv, float amount) { return (uv - 0.5) * -amount + uv; }`;

const curlNoise = `
vec2 curlNoise(vec2 p) {
  float e = 0.01;
  float dPdy = (valueNoise(p + vec2(0.0, e)) - valueNoise(p - vec2(0.0, e))) / (2.0 * e);
  float dPdx = (valueNoise(p + vec2(e, 0.0)) - valueNoise(p - vec2(e, 0.0))) / (2.0 * e);
  return vec2(dPdy, -dPdx);
}`;

const domainWarp = `
float domainWarp(vec2 p, int octaves) {
  vec2 q = vec2(fbm(p, octaves), fbm(p + vec2(5.2, 1.3), octaves));
  vec2 r = vec2(
    fbm(p + 4.0 * q + vec2(1.7, 9.2), octaves),
    fbm(p + 4.0 * q + vec2(8.3, 2.8), octaves)
  );
  return fbm(p + 4.0 * r, octaves);
}`;

const voronoi = `
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

const sdf3d = `
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

const raymarch = `
#ifndef FLUNCLE_MAP_FWD
#define FLUNCLE_MAP_FWD
float map(vec3 p);
#endif
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

const caustic = `
// Adapted from Paper Shaders (github.com/paper-design/shaders), Apache-2.0
float caustic(vec2 uv, float t, float scale, int iterations) {
  vec2 n = vec2(0.1);
  vec2 N = vec2(0.1);
  float c = cos(0.5);
  float s = sin(0.5);
  mat2 m = mat2(c, s, -s, c); // rotate2D(0.5), matches Paper's getCausticNoise
  for (int j = 0; j < 12; j++) {
    if (j >= iterations) break;
    uv *= m;
    n *= m;
    vec2 q = uv * scale + float(j) + n + (0.5 + 0.5 * float(j)) * (mod(float(j), 2.0) - 1.0) * t;
    n += sin(q);
    N += cos(q) / scale;
    scale *= 1.1;
  }
  float v = N.x + N.y + 1.0;
  return v * v; // squared -> true caustic filaments (Paper squares causticNoise)
}`;

const neuroWeb = `
// Adapted from Paper Shaders (github.com/paper-design/shaders), Apache-2.0
float neuroWeb(vec2 uv, float t, int iterations) {
  vec2 sine_acc = vec2(0.0);
  vec2 res = vec2(0.0);
  float scale = 8.0;
  float c = cos(1.0);
  float s = sin(1.0);
  mat2 rr = mat2(c, -s, s, c); // rotate by 1 rad per iteration
  for (int j = 0; j < 24; j++) {
    if (j >= iterations) break;
    uv = rr * uv;
    sine_acc = rr * sine_acc;
    vec2 layer = uv * scale + float(j) + sine_acc - t;
    sine_acc += sin(layer);
    res += (0.5 + 0.5 * cos(layer)) / scale;
    scale *= 1.2;
  }
  return res.x + res.y;
}`;

const swirlWarp = `
// Adapted from Paper Shaders (github.com/paper-design/shaders), Apache-2.0
vec2 swirlWarp(vec2 uv, float t, float swirl, int iterations) {
  for (int i = 1; i <= 20; i++) {
    if (i > iterations) break;
    float iF = float(i);
    uv.x += swirl / iF * cos(t + iF * 1.5 * uv.y);
    uv.y += swirl / iF * cos(t + iF * 1.0 * uv.x);
  }
  return uv;
}`;

const oklab = `
// Adapted from Paper Shaders (github.com/paper-design/shaders), Apache-2.0
vec3 srgbToLinearOk(vec3 c) { return pow(c, vec3(2.2)); }
vec3 linearToSrgbOk(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 linearToOklab(vec3 rgb) {
  float L = pow(0.4122214708 * rgb.r + 0.5363325363 * rgb.g + 0.0514459929 * rgb.b, 1.0 / 3.0);
  float M = pow(0.2119034982 * rgb.r + 0.6806995451 * rgb.g + 0.1073969566 * rgb.b, 1.0 / 3.0);
  float S = pow(0.0883024619 * rgb.r + 0.2817188376 * rgb.g + 0.6299787005 * rgb.b, 1.0 / 3.0);
  return vec3(
    0.2104542553 * L + 0.7936177850 * M - 0.0040720468 * S,
    1.9779984951 * L - 2.4285922050 * M + 0.4505937099 * S,
    0.0259040371 * L + 0.7827717662 * M - 0.8086757660 * S
  );
}
vec3 oklabToLinear(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
   -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
   -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}
vec3 oklabToOklch(vec3 lab) {
  return vec3(lab.x, length(lab.yz), atan(lab.z, lab.y));
}
vec3 oklchToOklab(vec3 lch) {
  return vec3(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z));
}
vec3 srgbToOklch(vec3 c) { return oklabToOklch(linearToOklab(srgbToLinearOk(c))); }
vec3 oklchToSrgb(vec3 lch) { return linearToSrgbOk(oklabToLinear(oklchToOklab(lch))); }
float mixHueOk(float h1, float h2, float mixer) {
  float d = mod(h2 - h1 + 3.14159265359, 6.28318530718) - 3.14159265359;
  return h1 + mixer * d; // shortest-arc hue interpolation
}
// Perceptual OKLCH mix of two sRGB colors (returns sRGB).
vec3 mixOklch(vec3 a, vec3 b, float mixer) {
  vec3 la = srgbToOklch(a);
  vec3 lb = srgbToOklch(b);
  float L = mix(la.x, lb.x, mixer);
  float C = mix(la.y, lb.y, mixer);
  // Treat near-neutral endpoints (warm-dark grounds like Deep Field carry a tiny
  // residual chroma) as hueless, so a dark->chromatic ramp holds the chromatic
  // hue and ramps chroma from ~0 instead of arcing through a spurious blue/purple.
  float H = la.z;
  if (la.y > 0.02 && lb.y > 0.02) {
    H = mixHueOk(la.z, lb.z, mixer);
  } else if (lb.y > 0.02) {
    H = lb.z;
  }
  return oklchToSrgb(vec3(L, C, H));
}
// The Retint ramp mixed perceptually — same stops as paletteRamp, no sRGB mud.
vec3 paletteRampOk(float t) {
  t = clamp(t, 0.0, 1.0);
  float s = t * 3.0;
  if (s < 1.0) return mixOklch(u_palette[0], u_palette[1], smoothstep(0.0, 1.0, s));
  if (s < 2.0) return mixOklch(u_palette[1], u_palette[2], smoothstep(0.0, 1.0, s - 1.0));
  return mixOklch(u_palette[2], u_palette[3], smoothstep(0.0, 1.0, s - 2.0));
}`;

const colorSpots = `
// Adapted from Paper Shaders (github.com/paper-design/shaders), Apache-2.0
vec2 colorSpotPosition(int i, float t) {
  float a = float(i) * 0.37;
  float b = 0.6 + fract(float(i) / 3.0) * 0.9;
  float c = 0.8 + fract(float(i + 1) / 4.0);
  return 0.5 + 0.5 * vec2(sin(t * b + a), cos(t * c + a * 1.5));
}
// Optional radius-scaled swirl of the sample point around (0.5,0.5).
vec2 colorSpotSwirl(vec2 uv, float amount) {
  vec2 p = uv - 0.5;
  float r = length(p);
  float ang = amount * r;
  float c = cos(ang);
  float s = sin(ang);
  return mat2(c, -s, s, c) * p + 0.5;
}
vec3 colorSpots(vec2 uv, vec3 colors[6], int count, float t) {
  vec3 col = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= count) break;
    vec2 pos = colorSpotPosition(i, t);
    float d = pow(length(uv - pos), 3.5);
    float w = 1.0 / (d + 1e-3);
    col += colors[i] * w;
    total += w;
  }
  return col / max(1e-4, total);
}`;

const grainDisplace = `
float grainDisplace(vec2 uv, float t, float scale, float amt) {
  float slice = floor(t * 24.0);
  float g = valueNoise(uv * scale + vec2(slice * 1.7, slice * 0.9 + 3.1));
  return amt * (g - 0.5);
}`;

const bayer = `
float bayer2i(vec2 c) {
  vec2 p = mod(floor(c), 2.0);
  return mod(2.0 * p.x + 3.0 * p.y, 4.0); // matrix [0 2 / 3 1], value 0..3
}
float bayer4i(vec2 c) {
  return 4.0 * bayer2i(mod(c, 2.0)) + bayer2i(floor(c / 2.0)); // 0..15
}
float bayer8i(vec2 c) {
  return 4.0 * bayer4i(mod(c, 4.0)) + bayer2i(floor(c / 4.0)); // 0..63
}
float bayer2(vec2 c) { return bayer2i(c) / 4.0; }
float bayer4(vec2 c) { return bayer4i(c) / 16.0; }
float bayer8(vec2 c) { return bayer8i(c) / 64.0; }`;

const liquidMetal = `
// Adapted from Paper Shaders (github.com/paper-design/shaders), Apache-2.0
float liquidMetalChannel(float c1, float c2, float sp, vec3 w, float blur, float bump, float tint, float tintA) {
  float ch = mix(c2, c1, smoothstep(0.0, 2.0 * blur, sp));
  float border = w[0];
  ch = mix(ch, c2, smoothstep(border, border + 2.0 * blur, sp));
  border = w[0] + 0.4 * (1.0 - bump) * w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2.0 * blur, sp));
  border = w[0] + 0.5 * (1.0 - bump) * w[1];
  ch = mix(ch, c2, smoothstep(border, border + 2.0 * blur, sp));
  border = w[0] + w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2.0 * blur, sp));
  float gt = (sp - w[0] - w[1]) / w[2];
  float gradient = mix(c1, c2, smoothstep(0.0, 1.0, gt));
  ch = mix(ch, gradient, smoothstep(border, border + 0.5 * blur, sp));
  // Tint via color-burn blending (Paper).
  ch = mix(ch, 1.0 - min(1.0, (1.0 - ch) / max(tint, 0.0001)), tintA);
  return ch;
}
vec3 liquidMetal(vec2 uv, float edge, float repetition, float shiftRed, float shiftBlue, float t, vec3 tint, float tintA) {
  float cycleWidth = max(repetition, 0.001);
  vec2 g = uv - 0.5;
  float diagBLtoTR = g.x - g.y;
  // Edge-gradient bump: a soft radial swell weighted up the frame (no fwidth).
  float bump = pow(clamp(1.8 * length(g), 0.0, 2.0), 1.2);
  bump = (1.0 - bump) * pow(clamp(uv.y, 0.0, 1.0), 0.3);
  bump = clamp(bump, 0.0, 1.0);
  float thin1 = 0.12 / cycleWidth * (1.0 - 0.4 * bump);
  float thin2 = 0.07 / cycleWidth * (1.0 + 0.4 * bump);
  float wide = 1.0 - thin1 - thin2;
  vec3 w = vec3(cycleWidth * thin1, cycleWidth * thin2, wide);
  float noise = simplexNoise(uv - t);
  edge += (1.0 - edge) * 0.2 * noise;
  // Diagonal stripe coordinate bent by the shape edge + bump.
  float direction = g.x + diagBLtoTR;
  float edgeBand = smoothstep(0.0, 1.0, edge) * (1.0 - smoothstep(0.0, 1.0, edge));
  direction -= 2.0 * noise * diagBLtoTR * edgeBand;
  direction *= (0.1 + (1.1 - edge) * bump);
  direction *= (0.4 + 0.6 * (1.0 - smoothstep(0.5, 1.0, edge)));
  direction *= (0.5 + 0.5 * pow(clamp(uv.y, 0.0, 1.0), 2.0));
  direction *= cycleWidth;
  direction -= t;
  // Per-channel R/B dispersion shift.
  float disp = clamp(1.0 - bump, 0.0, 1.0);
  float dispRed = (disp - diagBLtoTR) * (shiftRed / 20.0);
  float dispBlue = (disp * 1.3) * (shiftBlue / 20.0);
  float blur = 0.07; // small analytic blur (WebGL1: no fwidth)
  vec3 c1 = vec3(0.98, 0.98, 1.0);
  vec3 c2 = vec3(0.1, 0.1, 0.1 + 0.1 * smoothstep(0.7, 1.3, g.x + g.y + 1.0));
  float r = liquidMetalChannel(c1.r, c2.r, fract(direction + dispRed), w, blur, bump, tint.r, tintA);
  float gc = liquidMetalChannel(c1.g, c2.g, fract(direction), w, blur, bump, tint.g, tintA);
  float b = liquidMetalChannel(c1.b, c2.b, fract(direction - dispBlue), w, blur, bump, tint.b, tintA);
  return vec3(r, gc, b);
}`;

const tonemap = `
vec3 acesFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 reinhardJodie(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 tc = c / (1.0 + c);
  return mix(c / (1.0 + l), tc, tc);
}
vec3 liftGammaGain(vec3 col, vec3 lift, vec3 gamma, vec3 gain) {
  col = col * gain + lift * (1.0 - col);
  return pow(max(col, 0.0), 1.0 / max(gamma, vec3(1e-3)));
}
vec3 liftGammaGain(vec3 col, float lift, float gamma, float gain) {
  return liftGammaGain(col, vec3(lift), vec3(gamma), vec3(gain));
}`;

const noise3 = `
vec3 hash33(vec3 p) {
  p = vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return fract(sin(p) * 43758.5453);
}
float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  float x00 = mix(n000, n100, u.x);
  float x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x);
  float x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
float fbm3(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  mat3 rot = mat3(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64); // decorrelate octaves
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * valueNoise3(p);
    norm += amp;
    p = rot * p * 2.0 + 7.3;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}
vec3 voronoi3(vec3 p) {
  vec3 n = floor(p);
  vec3 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 g = vec3(float(i), float(j), float(k));
        vec3 o = hash33(n + g);
        vec3 r = g + o - f;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; id = hash13(n + g); }
        else if (d < f2) { f2 = d; }
      }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}
// Divergence-free 2D flow from a 3D potential; z=t advances monotonically so the
// flow roils in place (never returns) instead of scrolling a frozen field.
vec2 curl3(vec3 p, float t) {
  float e = 0.01;
  vec3 P = vec3(p.xy, p.z + t);
  float dPdy = (fbm3(P + vec3(0.0, e, 0.0), 3) - fbm3(P - vec3(0.0, e, 0.0), 3)) / (2.0 * e);
  float dPdx = (fbm3(P + vec3(e, 0.0, 0.0), 3) - fbm3(P - vec3(e, 0.0, 0.0), 3)) / (2.0 * e);
  return vec2(dPdy, -dPdx);
}`;

const sdfPresence = `
// WebGL1 has no round(): floor(v + 0.5) is the exact substitute for repetition.
vec3 sdfRound(vec3 v) { return floor(v + 0.5); }
// Standalone interleaved-gradient noise (blue-noise-ish), for march-start jitter.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// Smooth intersection / carving: smax(a,b,k) = -smin(-a,-b,k). Carve fbm from a
// colonnade for RUINS, or a window from a hull.
float smax(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}
// Smooth union that also returns the BLEND factor (x=distance, y=0..1 blend, 1=all a):
// blend material where a limb fuses into a body.
vec2 sminV(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return vec2(mix(b, a, h) - k * h * (1.0 - h), h);
}
// Infinite domain repetition (IQ): fold p into one cell of size s.
vec3 opRepeat(vec3 p, vec3 s) { return p - s * sdfRound(p / s); }
// Limited repetition: l cells each way from the origin (the forest that ENDS).
vec3 opRepeatLim(vec3 p, float s, vec3 l) { return p - s * clamp(sdfRound(p / s), -l, l); }
// 3D capsule: a segment a→b of radius r (limbs, necks, tentacles).
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
// 3D round cone along +Y: radius r1 at the base, r2 at height h — the tapering limb.
float sdRoundCone(vec3 p, float r1, float r2, float h) {
  vec2 q = vec2(length(p.xz), p.y);
  float b = (r1 - r2) / h;
  float a = sqrt(max(1.0 - b * b, 0.0));
  float k = dot(q, vec2(-b, a));
  if (k < 0.0) return length(q) - r1;
  if (k > a * h) return length(q - vec2(0.0, h)) - r2;
  return dot(q, vec2(a, b)) - r1;
}
// 3D ellipsoid — a BOUND (not exact); march conservatively. Guarded at the centre.
float sdEllipsoid(vec3 p, vec3 r) {
  float k1 = length(p / (r * r));
  if (k1 < 1e-5) return -min(r.x, min(r.y, r.z));
  float k0 = length(p / r);
  return k0 * (k0 - 1.0) / k1;
}
// 2D segment (unsigned) — a stroke, a trunk, rigging.
float sd2dSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
// 2D triangle (signed) — a fin, a wing membrane, a spire.
float sd2dTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(
    min(
      vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
      vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))
    ),
    vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x))
  );
  return -sqrt(d.x) * sign(d.y);
}
// 4-tap tetrahedral normal (IQ) — define your own float map(vec3 p). The prototype is
// guarded so composing this alongside \`raymarch\` (which also declares map) is legal
// (GLSL ES rejects a duplicate prototype).
#ifndef FLUNCLE_MAP_FWD
#define FLUNCLE_MAP_FWD
float map(vec3 p);
#endif
vec3 calcNormal4(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.001;
  return normalize(
    k.xyy * map(p + k.xyy * e) +
    k.yyx * map(p + k.yyx * e) +
    k.yxy * map(p + k.yxy * e) +
    k.xxx * map(p + k.xxx * e)
  );
}`;

const glowWithDirt = `
// Cheap clumpy speckle, boiled on an integer time slice (self-contained hash).
float glowDirtSpeckle(vec2 uv, float t, float seed) {
  vec2 c = floor(uv * 480.0 + floor(t * 12.0) * 7.13 + seed);
  return fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453123);
}
vec3 glowWithDirt(vec3 col, vec3 glowColor, float glow, vec2 uv, float t, float seed) {
  col += glowColor * glow;                                                 // the additive light
  float lum = clamp(dot(glowColor, vec3(0.299, 0.587, 0.114)) * glow, 0.0, 1.0);
  float n = glowDirtSpeckle(uv, t, seed);
  float dirt = step(0.82 - 0.30 * lum, n);                                  // more specks where hotter
  return col - glowColor * (0.28 * glow) * dirt;                            // dark motes inside the glow
}`;

const hiddenLineOcclusion = `
float hiddenLine(float y, float h, inout float peak, float thickness, float aa) {
  float stroke = smoothstep(thickness + aa, thickness - aa, abs(y - h));
  float visible = step(peak, h);   // shows only where it clears every nearer line
  peak = max(peak, h);
  return stroke * visible;
}`;

const rampRetint = `
vec3 rampRetint(vec3 src) {
  float l = dot(src, vec3(0.299, 0.587, 0.114));
  vec3 hue = paletteRamp(l);                          // the warm-dark→cream hue arc
  float hl = dot(hue, vec3(0.299, 0.587, 0.114));
  return hue * (hl > 1e-4 ? l / hl : 1.0);            // rescale so output luma == input luma
}`;

export const GLSL = {
  bayer,

  caustic,

  chromaticAberration,

  colorSpots,

  curlNoise,

  domainWarp,

  dotField,

  fbm,

  filmGrain,

  glowWithDirt,

  grainDisplace,

  grainFamilies,

  hash,

  hiddenLineOcclusion,

  liquidMetal,

  neuroWeb,

  noise3,

  oklab,

  paletteRamp,

  polarFold,

  rampRetint,

  raymarch,

  sdf,

  sdf3d,

  sdfPresence,

  simplexNoise,

  swirlWarp,

  tonemap,

  valueNoise,

  vignette,

  voronoi,
} as const;

export type GlslSnippet = keyof typeof GLSL;
