// Fluncle LIVE — "the glass" v0.6 (show-usable single-file live runtime).
//
// A fullscreen WebGL page that renders the REAL packages/video GLSL vocabulary
// (imported below, zero duplication) driven by LIVE audio (BlackHole / the audio
// interface = the Rekordbox master) instead of precomputed curves. THE PLAN (the
// published mixtape's tracklist) is loaded on boot, each finding's palette + seed
// steer an ARRIVAL, and the operator flies the pointer with the arrow keys.
//
// v0.6 — DREAM REPLAY. On arrival at a finding the glass now tries to run the
// finding's OWN archived shader world LIVE, with a graceful fallback ladder:
//   tier 0  replayed (own shader)   — the archived composition's fragment body,
//                                      resolved server-side, compiled as a SECOND
//                                      WebGL program on a SECOND canvas stacked over
//                                      the base, crossfaded in over ~1.5s. Its
//                                      journey-helper uniforms are re-driven LIVE:
//                                      u_rise-class → dwell ramp (0→1 over 30s);
//                                      u_settle-class → pinned (no tail dim); audio
//                                      aliases → the live DSP; colour vec3s → the
//                                      finding palette; u_progress → dwell/len.
//   tier 1  default[vehicle]        — not replayable (multi-layer, vec2/velocity
//                                      taps, or a non-GLSL interpolation): the base
//                                      vehicle chosen by the finding's videoVehicle
//                                      tag (caustic/neuro/roil), palette+seed morph.
//   tier 2  (free) default[hash]    — anything: the base canvas keeps running the
//                                      default-vehicle world UNDER the replay canvas,
//                                      so a replay compile/GL error just stays here.
//
// Run:  bun serve.ts   then open  http://localhost:4173
//
// Keys (operator cheat-sheet):
//   ← / n   advance the plan pointer (ARRIVAL: crossfade to the next finding)
//   → / p   rewind the plan pointer
//   0       ease into the HOLDING scene (warm-dark rest; no gold)
//   b       BLACKOUT — HOLD ~360ms to engage (eases into holding); tap again to return
//   - / =   global intensity down / up (scales audio reactivity, 0.4–1.3)
//   1/2/3   pick the base vehicle manually (turns auto-morph off; also drops replay)
//   m       auto-morph toggle (default OFF — arrivals own the morphs)
//   v       toggle dream-replay on/off (force the tag-mapped default vehicle)
//   r       render scale (1.0 / 0.75 / 0.5)
//   h       HUD show/hide
//   d       demo beat (a 174bpm DnB-ish synth through the same analyser)
//
// The fiction (RFC §0/§2): the archive's clips are the observations; the live
// set is Fluncle DREAMING. v0.6 lets the dream replay the finding's OWN world
// when it can (header-uniform-only bodies), and re-shape it through a cleared
// vehicle when it can't. The dream distorts what was lived, by design — the live
// re-drive of a clip's journey uniforms is NOT the offline render 1:1.
import { GLSL } from "/Users/maurice/Projects/fluncle/packages/video/src/remotion/journey/glsl.ts";

// ===========================================================================
// SERVER-SIDE SCENE EXTRACTION — resolve an archived composition's fragment body
// to a self-contained, replay-ready GLSL string + classify its custom uniforms.
// ===========================================================================

// The header uniform names the live glass injects (must match CORE_UNIFORMS in
// packages/video/src/remotion/journey/shader-layer.tsx). A `uniform` the body
// declares that is NOT in this set is a CUSTOM uniform (a journey helper).
const HEADER_UNIFORMS = new Set([
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

// The exact core-uniform + dither block ShaderLayer injects, so the replay
// program compiles the archived body byte-for-byte the way the offline render did.
const CORE_UNIFORMS_GLSL = `uniform float u_time;
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

const DITHER_HELPERS_GLSL = `float ditherValue(vec2 fragCoord) {
  vec2 p = fract(fragCoord * vec2(0.7548776662, 0.5698402909));
  float n = fract(p.x * p.y * 437.585453);
  return (n - 0.5) / 255.0;
}
vec3 dither8(vec3 col, vec2 uv) {
  return col + ditherValue(uv * u_res);
}`;

// The header prepended to a replay body client-side to form the full fragment.
const REPLAY_HEADER = `precision highp float;\n${CORE_UNIFORMS_GLSL}\n\n${DITHER_HELPERS_GLSL}\n\n`;

type Cls = "riseRamp" | "settleDim" | "audioAlias" | "color" | "unknown";
type CustomU = { name: string; type: string; class: Cls; params?: Record<string, unknown> };

function audioFieldOf(name: string, driver: string | null): string {
  const s = (name + " " + (driver ?? "")).toLowerCase();
  if (/ignite|gold|\bdrop\b/.test(s)) {
    return "drop";
  }
  if (/bass|kick|sub|thick|low/.test(s)) {
    return "bass";
  }
  if (/treble|air|hat|sparkle|hiss/.test(s)) {
    return "treble";
  }
  if (/mid|lead|snare/.test(s)) {
    return "mid";
  }
  if (/hit|onset|chroma|edge/.test(s)) {
    return "hit";
  }
  return "swell";
}

function colorStopOf(name: string): number {
  const n = name.toLowerCase();
  if (/bkg|\bbg\b|ink|deep|dark|ground|black|void|dust/.test(n)) {
    return 0;
  }
  if (/warm|gold|amber|hot|cream|\bhi\b|light|glo|peak|sun|crest/.test(n)) {
    return 3;
  }
  return 2; // mid/glow default (teal, sage, accent…)
}

function classifyFloat(
  name: string,
  driver: string | null,
): { class: Cls; params?: Record<string, unknown> } {
  const n = name.toLowerCase();
  // Outro controls (tail dimmers / close-card reveals) win over any ramp shape:
  // LIVE we never play the outro, so PIN them to their pre-outro value.
  if (/settle|recede|close|outro/.test(n)) {
    return { class: "settleDim", params: { hold: /settle/.test(n) ? 1.0 : 0.0 } };
  }
  // Driver-expression refinement (faithful to the JS driver) when available.
  if (driver) {
    if (/\b(audio|reactivity)\b|\.swell|\.energy|\.bass|\.mid|\.treble|\bRx\b/.test(driver)) {
      return { class: "audioAlias", params: { field: audioFieldOf(n, driver) } };
    }
    const arrs = [...driver.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
    if (/interpolate\s*\(/.test(driver) && arrs.length >= 2) {
      const vals = arrs[1]
        .split(",")
        .map((s) => parseFloat(s))
        .filter((x) => !Number.isNaN(x));
      if (vals.length >= 2) {
        const first = vals[0];
        const last = vals[vals.length - 1];
        if (first <= 0.05 && last > first) {
          return { class: "riseRamp" };
        }
        if (first >= 0.9 && last < first) {
          return { class: "settleDim", params: { hold: 1.0 } };
        }
        if (first <= 0.05 && last <= 0.05) {
          return { class: "riseRamp" };
        }
      }
    }
  }
  // Name-keyword fallback.
  if (
    /swell|thick|sheen|chroma|\bhit\b|bio|core|sharp|crease|expose|detail|amp|edge|bright|grain|curl|filament|haze|crest|build|sparkle|glow|ignite|gold|drop/.test(
      n,
    )
  ) {
    return { class: "audioAlias", params: { field: audioFieldOf(n, null) } };
  }
  if (
    /arc|grow|struct|rise|climax|flow|travel|drift|aperture|m[123]\b|_z\b|lean|hue|band|approach|passage|open|reveal|resolve|dif\b/.test(
      n,
    )
  ) {
    return { class: "riseRamp" };
  }
  return { class: "unknown" };
}

// Find the JS driver expression feeding a custom uniform (best-effort, for the
// classifier's refinement — the name-keyword fallback covers a miss).
function findDriver(src: string, uni: string): string | null {
  const m = src.match(new RegExp(uni + "\\s*:\\s*([^,\\n}]+)"));
  if (!m) {
    return null;
  }
  const rhs = m[1].trim();
  if (/^toVec3\(|^hexToRgb\(|^\[/.test(rhs)) {
    return rhs;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(rhs)) {
    const cm = src.match(new RegExp("const\\s+" + rhs + "\\s*=\\s*([\\s\\S]{0,400}?);\\s*\\n"));
    return cm ? cm[1] : rhs;
  }
  return rhs;
}

export type Scene = {
  replayable: boolean;
  reason?: string;
  body?: string;
  customUniforms: CustomU[];
};

function extractScene(src: string): Scene {
  // 1. Slice every /* glsl */-tagged template literal (the composition frag has no
  // backticks inside it — the stray ones live in JS comments outside the literal),
  // then pick the one containing void main().
  const marker = "/* glsl */";
  const bodies: string[] = [];
  let idx = 0;
  while ((idx = src.indexOf(marker, idx)) !== -1) {
    const open = src.indexOf("`", idx);
    if (open === -1) {
      break;
    }
    const close = src.indexOf("`", open + 1);
    if (close === -1) {
      break;
    }
    bodies.push(src.slice(open + 1, close));
    idx = close + 1;
  }
  const raw = bodies.find((b) => /void\s+main\s*\(/.test(b));
  if (!raw) {
    return {
      customUniforms: [],
      reason: "no /* glsl */ frag with void main (multi-layer/untagged composition)",
      replayable: false,
    };
  }

  // 2. Resolve ${…} — bare GLSL.member only (D2: emission is module evaluation).
  let bad: string | null = null;
  const body = raw.replace(/\$\{([^}]*)\}/g, (_m, expr) => {
    const t = String(expr).trim();
    const gm = t.match(/^GLSL\.(\w+)$/);
    if (gm && gm[1] in GLSL) {
      return (GLSL as Record<string, string>)[gm[1]];
    }
    bad = t;
    return "";
  });
  if (bad) {
    return { customUniforms: [], reason: `non-GLSL interpolation: ${bad}`, replayable: false };
  }

  // 3. Custom uniform declarations (the composition's own; the header set excluded).
  const customs: CustomU[] = [];
  const re = /^\s*uniform\s+(\w+)\s+(u_\w+)\s*;/gm;
  let um: RegExpExecArray | null;
  while ((um = re.exec(raw)) !== null) {
    const type = um[1];
    const name = um[2];
    if (HEADER_UNIFORMS.has(name)) {
      continue;
    }
    // vec2 + velocity (…Vel) + glide taps are JS-integrated motion (position, not
    // material) — the live host has no integrator for them → not replayable.
    if (type === "vec2" || name.endsWith("Vel") || /glide/i.test(name)) {
      return {
        customUniforms: [],
        reason: `vec2/velocity motion uniform ${name} (JS-integrated travel, not replayable live)`,
        replayable: false,
      };
    }
    if (type === "vec3") {
      customs.push({ class: "color", name, params: { stop: colorStopOf(name) }, type });
    } else {
      const c = classifyFloat(name, findDriver(src, name));
      customs.push({ class: c.class, name, params: c.params, type });
    }
  }

  return { body, customUniforms: customs, replayable: true };
}

// Map a descriptive videoVehicle tag → the default base-vehicle scene index.
//   0 caustic wall · 1 neuro web · 2 fbm3 roil · -1 = unknown (fall back to hash).
function vehicleToScene(tag: string | null | undefined): number {
  if (!tag) {
    return -1;
  }
  const t = tag.toLowerCase();
  // caustic is the most specific material term — check it before the "web" group.
  if (/caustic|liquid|ripple|refract|glass|water|crystal|iridescent|thin-film|film|veil/.test(t)) {
    return 0;
  }
  if (/filament|vein|wire|dendrite|weft|sinew|thread|web|strand|neuro|nerve/.test(t)) {
    return 1;
  }
  if (
    /roil|smoke|cloud|field|drape|bloom|swarm|murmur|spindrift|flux|drift|haze|plume|mist|billow|dust|vapor|fog/.test(
      t,
    )
  ) {
    return 2;
  }
  return -1;
}

const FRAG = /* glsl */ `
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
  // Warm Dark holds: the field stays near-black, only the caustic filaments lift.
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

// The 4th scene: the canon HOLDING scene (RFC §2). Warm Dark ground + a slow
// boiling grain-field, a beat-clock-only ambient pulse on the swell, and NO gold
// — the single terminal rest state (blackout target, silence target, key 0).
vec3 sceneHolding(vec2 p, float t) {
  float n = fbm3(vec3(p * 1.5, t * 0.045), 4);
  float boil = 0.028 + 0.06 * u_swell * (0.5 + 0.5 * n);
  vec3 g = u_palette[0]; // the finding's (or canon) warm-dark ground
  // Deliberately warm and gold-free: lift toward cream-red, kill the cool.
  return g + vec3(boil, boil * 0.82, boil * 0.68);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  // Seed offset: each finding shows a different window/phase of the same world.
  p += vec2(u_seed * 7.0, u_seed * 11.0);
  float t = u_time + u_seed * 40.0;

  float s = u_scene;
  float w0 = clamp(1.0 - abs(s - 0.0), 0.0, 1.0);
  float w1 = clamp(1.0 - abs(s - 1.0), 0.0, 1.0);
  float w2 = clamp(1.0 - abs(s - 2.0), 0.0, 1.0);
  // wrap: scene 2 -> 0 crossfade
  w0 += clamp(1.0 - abs(s - 3.0), 0.0, 1.0);

  vec3 col = vec3(0.0);
  if (w0 > 0.001) col += w0 * sceneCaustic(p, t);
  if (w1 > 0.001) col += w1 * sceneNeuro(p, t);
  if (w2 > 0.001) col += w2 * sceneRoil(p, t);

  // Ease into the holding scene (blackout / silence / key 0) — never to #000.
  if (u_holding > 0.001) col = mix(col, sceneHolding(p, t), u_holding);

  // RAIL 1 — the Warm Dark output clamp: the field never blows past the ceiling.
  col = min(col, vec3(0.92));
  // RAIL 2 — the Light-Years grade, live: gentle emulsion boil, grain floor
  // always present (>= 0.04), so the frame is never a dead flat black.
  col = filmGrain(col, uv, u_time, 0.05);
  gl_FragColor = vec4(col, 1.0);
}
`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fluncle LIVE — the glass</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;height:100%;background:#090a0b;overflow:hidden;font:12px/1.5 ui-monospace,Menlo,monospace;color:#f4ead7}
  canvas{display:block;position:fixed;inset:0;width:100vw;height:100vh}
  /* Base canvas = the default-vehicle world (also the instant replay fallback). */
  #c{z-index:0}
  /* Replay canvas = the finding's OWN shader, crossfaded above the base. */
  #c2{z-index:1;opacity:0;transition:none;pointer-events:none}
  /* The currently-playing PLATE — top-left, DOM overlay, Stories grammar. */
  #plate{position:fixed;top:24px;left:26px;max-width:min(48vw,560px);z-index:3;
    background:rgba(9,10,11,0.55);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);
    border-radius:8px;padding:14px 18px;pointer-events:none;
    opacity:0;transform:translateY(-8px);transition:opacity .3s ease,transform .3s ease}
  #plate.show{opacity:1;transform:none}
  #p-coord{font-family:Oxanium,ui-sans-serif,system-ui,sans-serif;font-weight:600;
    font-variant-numeric:tabular-nums;letter-spacing:.02em;color:#f5b800;font-size:.95rem;line-height:1;margin-bottom:8px}
  #p-title{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;font-weight:800;
    color:#f4ead7;font-size:1.4rem;line-height:1.14;letter-spacing:-.01em}
  #p-artist{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;font-weight:400;
    color:#b7ab95;font-size:1rem;line-height:1.2;margin-top:5px}
  #p-found{font-family:Oxanium,ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;
    color:#b7ab95;font-size:.78rem;letter-spacing:.03em;margin-top:9px}
  #plate.blackarm{outline:1px solid #f5b80055}
  #hud{position:fixed;left:12px;bottom:12px;z-index:3;background:#10100dcc;padding:10px 12px;border:1px solid #d0b99029;border-radius:8px;white-space:pre;max-width:52vw}
  #err{position:fixed;top:12px;right:12px;z-index:3;color:#ff6b57;white-space:pre-wrap;max-width:60vw;text-align:right}
  button,select{background:#171611;color:#f4ead7;border:1px solid #d0b99029;border-radius:6px;padding:4px 8px;font:inherit;margin-right:6px}
  .dim{color:#b7ab95}
  .rep{color:#8fe388}
</style></head><body>
<canvas id="c"></canvas>
<canvas id="c2"></canvas>
<div id="plate"><div id="p-coord"></div><div id="p-title"></div><div id="p-artist"></div><div id="p-found"></div></div>
<div id="err"></div>
<div id="hud">
  <div style="margin-bottom:6px">
    <select id="devices"></select>
    <button id="live">use live input</button>
    <button id="demo">demo beat</button>
  </div>
  <span id="hudinfo" class="dim">loading plan…</span>
  <div id="world" style="margin-top:4px" class="dim">world: —</div>
  <div id="meters" style="margin-top:4px">—</div>
</div>
<script>
const FRAG = ${JSON.stringify(FRAG)};
const REPLAY_HEADER = ${JSON.stringify(REPLAY_HEADER)};
const VERT = "attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }";
// Canon default palette (uncharted space): Deep Field, Re-entry Red, Eclipse Gold, Starlight Cream.
const CANON = [[0.035,0.039,0.043],[1.0,0.42,0.34],[0.96,0.72,0.0],[0.957,0.918,0.843]];
const err = (m) => { document.getElementById("err").textContent = m; };
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const easeInOut = (x)=>{ x=Math.min(Math.max(x,0),1); return x<0.5? 4*x*x*x : 1-Math.pow(-2*x+2,3)/2; };
const smooth = (a,b,x)=>{ const t=Math.min(Math.max((x-a)/Math.max(b-a,1e-4),0),1); return t*t*(3-2*t); };

// ---- base GL (canvas #c) ----
const canvas = document.getElementById("c");
const gl = canvas.getContext("webgl", { antialias: false });
function compile(g, type, src, tag){ const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s);
  if(!g.getShaderParameter(s, g.COMPILE_STATUS)) { const log=g.getShaderInfoLog(s); if(tag) throw new Error(tag+": "+log); err("shader: "+log); throw new Error("compile"); } return s; }
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog);
if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) err("link: " + gl.getProgramInfoLog(prog));
gl.useProgram(prog);
const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, "a"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
const U = (n) => gl.getUniformLocation(prog, n);
window.__frames = 0;

// ---- replay GL (canvas #c2) — a SECOND context/program, rebuilt per arrival ----
const canvas2 = document.getElementById("c2");
const gl2 = canvas2.getContext("webgl", { alpha: false, antialias: false });
const buf2 = gl2.createBuffer(); gl2.bindBuffer(gl2.ARRAY_BUFFER, buf2);
gl2.bufferData(gl2.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl2.STATIC_DRAW);
let replayProg = null, replayLocCache = null, replayVs = null, replayFs = null;
window.__replay = false;
// Delete the previous replay program + shaders (memory discipline — two canvases max).
function disposeReplay(){
  if(replayProg){ gl2.deleteProgram(replayProg); replayProg=null; }
  if(replayVs){ gl2.deleteShader(replayVs); replayVs=null; }
  if(replayFs){ gl2.deleteShader(replayFs); replayFs=null; }
  replayLocCache = null;
}
// Compile an archived body as a fresh replay program. Returns true on success.
function buildReplay(body){
  disposeReplay();
  const src = REPLAY_HEADER + body;
  try {
    replayVs = compile(gl2, gl2.VERTEX_SHADER, VERT, "vert");
    replayFs = compile(gl2, gl2.FRAGMENT_SHADER, src, "frag");
  } catch(e){ disposeReplay(); throw e; }
  const p = gl2.createProgram();
  gl2.attachShader(p, replayVs); gl2.attachShader(p, replayFs); gl2.linkProgram(p);
  if(!gl2.getProgramParameter(p, gl2.LINK_STATUS)){ const log=gl2.getProgramInfoLog(p); gl2.deleteProgram(p); disposeReplay(); throw new Error("link: "+log); }
  replayProg = p;
  gl2.useProgram(p);
  gl2.bindBuffer(gl2.ARRAY_BUFFER, buf2);
  const al = gl2.getAttribLocation(p, "a"); gl2.enableVertexAttribArray(al); gl2.vertexAttribPointer(al, 2, gl2.FLOAT, false, 0, 0);
  replayLocCache = {};
  return true;
}
const RU = (n) => { if(!replayLocCache) return null; if(!(n in replayLocCache)) replayLocCache[n]=gl2.getUniformLocation(replayProg,n); return replayLocCache[n]; };

// ---- palette helpers: the finding's props.json -> the four u_palette stops ----
function hexToRgb(h){ if(!h) return null; h=h.replace('#',''); if(h.length===3) h=h.split('').map(c=>c+c).join('');
  const n=parseInt(h,16); return [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255]; }
function warmDarkClamp(rgb){ if(!rgb) return CANON[0].slice();
  const cap=0.11; const mx=Math.max(rgb[0],rgb[1],rgb[2]);
  const k = mx>cap ? cap/mx : 1; return [rgb[0]*k, rgb[1]*k, rgb[2]*k]; }
// The BASE-vehicle ramp (v0.5): stop0 warm-dark-clamped, stop1 a darkened accent.
function paletteFromEntry(e){
  const P = e && e.palette;
  if(!P) return CANON.map(c=>c.slice());
  const bg = warmDarkClamp(hexToRgb(P.background));
  const accent = hexToRgb(P.accent) || CANON[1];
  const glow = hexToRgb(P.glow) || CANON[2];
  const darkAccent = accent.map(c=>c*0.5);
  return [bg, darkAccent, accent, glow];
}
// The REPLAY ramp: the finding's OWN stops [background, accent, glow, ink] straight
// through (archived bodies design their own retint over u_palette; the v0.5
// dark-half massaging would fight them). Colour vec3 customs draw from these too.
function paletteReplay(e){
  const P = e && e.palette;
  if(!P) return CANON.map(c=>c.slice());
  return [ hexToRgb(P.background)||CANON[0], hexToRgb(P.accent)||CANON[1], hexToRgb(P.glow)||CANON[2], hexToRgb(P.ink)||hexToRgb(P.glow)||CANON[3] ];
}
function flat(stops){ return [].concat(stops[0],stops[1],stops[2],stops[3]); }
function hashStr(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0); }

// ---- live DSP (mirrors the pipeline's band conventions: <150 / 150-2k / >2k) ----
const AC = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }); window.__ac = AC;
const analyser = AC.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0;
const sink = AC.createGain(); sink.gain.value = 0; analyser.connect(sink); sink.connect(AC.destination);
const bins = new Float32Array(analyser.frequencyBinCount);
const hz = (i) => i * AC.sampleRate / analyser.fftSize;
let sBass=0, sMid=0, sTreble=0, sEnergy=0, swell=0, kick=0, prevBass=0;
let peak = 1e-6;
function dsp(){
  analyser.getFloatFrequencyData(bins);
  let b=0,bn=0,m=0,mn=0,t=0,tn=0;
  for(let i=1;i<bins.length;i++){
    const f = hz(i); const mag = Math.pow(10, bins[i]/20);
    if(f<150){b+=mag;bn++;} else if(f<2000){m+=mag;mn++;} else if(f<16000){t+=mag;tn++;}
  }
  b/=bn||1; m/=mn||1; t/=tn||1;
  peak = Math.max(b, m, peak*0.9995, 1e-6);
  const nb=Math.min(1,b/peak), nm=Math.min(1,m/peak), nt=Math.min(1,t/(peak*0.35));
  const ema=(s,v,a,d)=> v>s ? s+(v-s)*a : s+(v-s)*d;
  sBass=ema(sBass,nb,0.5,0.12); sMid=ema(sMid,nm,0.4,0.1); sTreble=ema(sTreble,nt,0.5,0.15);
  sEnergy=ema(sEnergy, nb*0.5+nm*0.35+nt*0.15, 0.3, 0.06);
  swell=ema(swell, sEnergy, 0.02, 0.01);
  const delta=Math.max(0, nb-prevBass); prevBass=nb;
  kick=Math.max(kick*0.86, Math.min(1, delta*4));
}

// ---- state: the plan, the pointer, arrivals, holding, intensity, REPLAY ----
let PLAN = [];
let pointer = -1;
let scene=0, sceneTarget=0, autoMorph=false, dipped=false, dipT=0;
let renderScale=0.75;
let palCur = flat(CANON.map(c=>c.slice())), palTar = flat(CANON.map(c=>c.slice()));
let palCurR = flat(CANON.map(c=>c.slice())), palTarR = flat(CANON.map(c=>c.slice())); // replay ramp
let seedCur=0, seedTar=0;
let seedRawCur=0, seedRawTar=0;   // the RAW (big-int) seed archived bodies expect
let holdCur=0;
let intensity=1.0;
let manualHold=false, blackoutEngaged=false, silenceHold=false;
let blackoutTimer=null, silentSince=0;
let dropEnv=0;                    // live u_audioDrop analog (surge above the swell baseline)
// replay state
let replayEnabled=true;           // key v
let replayActive=false;           // the current arrival is running its own shader
let replayFade=0;                 // 0..1 crossfade of the replay canvas (~1.5s ease)
let replayCustoms=[];             // classified custom uniforms of the active scene
let replayExpectedLenMs=300000;   // for u_progress
let arriveMs=0;                   // wall-clock of the current arrival (dwell base)
let worldStatus="world: —";

// ---- the currently-playing plate (DOM overlay) ----
const plate = document.getElementById("plate");
function foundStr(iso){ if(!iso) return ""; const d=new Date(iso); if(isNaN(d)) return "";
  return "Found "+MONTHS[d.getUTCMonth()]+" "+d.getUTCDate(); }
function showPlate(e){
  document.getElementById("p-coord").textContent = e.logId;
  document.getElementById("p-title").textContent = e.title || "";
  document.getElementById("p-artist").textContent = (e.artists||[]).join(", ");
  const f = foundStr(e.foundAt); const fe = document.getElementById("p-found");
  fe.textContent = f; fe.style.display = f ? "block" : "none";
  plate.classList.add("show");
}
function hidePlate(){ plate.classList.remove("show"); }

// ---- arrival: crossfade the world to a finding; try DREAM REPLAY, else tag-map ----
function arrive(idx){
  if(!PLAN.length) return;
  pointer = ((idx % PLAN.length) + PLAN.length) % PLAN.length;
  const e = PLAN[pointer];
  palTar = flat(paletteFromEntry(e));
  palTarR = flat(paletteReplay(e));
  seedTar = ((e.seed||0) % 100000) / 100000;
  seedRawTar = (e.seed||0);
  autoMorph = false;
  manualHold = false;
  arriveMs = performance.now();
  replayExpectedLenMs = e.durationMs || 300000;

  // ---- the replay ladder ----
  const rp = e.replay || { replayable:false, reason:"no scene data" };
  const vehScene = vehicleTag(e);
  let ok=false;
  if(replayEnabled && rp.replayable && rp.body){
    try {
      buildReplay(rp.body);
      replayCustoms = rp.customUniforms || [];
      replayActive = true; ok=true;
      worldStatus = "world: replayed (own shader) · "+ (replayCustoms.length? replayCustoms.length+" custom u" : "clean, header-only");
    } catch(ex){
      err("replay compile ["+e.logId+"]: "+ex.message);
      replayActive = false;
      worldStatus = "world: default["+vehName(vehScene)+"] (replay FAILED to compile — free fallback)";
    }
  } else {
    replayActive = false;
    worldStatus = "world: default["+vehName(vehScene)+"]" + (rp.replayable? "" : " (reason: "+(rp.reason||"n/a")+")");
  }
  if(!replayActive){
    disposeReplay();
    // tier 1: pick the base vehicle by the videoVehicle tag; else hash (neighbours differ).
    sceneTarget = vehScene>=0 ? vehScene : (hashStr(e.logId) % 3);
  } else {
    // keep the base world evolving underneath on a hash vehicle (the free fallback)
    sceneTarget = hashStr(e.logId) % 3;
  }
  showPlate(e);
  updateHud();
}
function vehicleTag(e){ return vehicleToScene(e.videoVehicle); }
function vehName(i){ return i===0?"caustic": i===1?"neuro": i===2?"roil":"hash"; }
// server-side helper mirrored client-side (kept in sync with vehicleToScene above)
function vehicleToScene(tag){
  if(!tag) return -1; const t=tag.toLowerCase();
  if(/caustic|liquid|ripple|refract|glass|water|crystal|iridescent|thin-film|film|veil/.test(t)) return 0;
  if(/filament|vein|wire|dendrite|weft|sinew|thread|web|strand|neuro|nerve/.test(t)) return 1;
  if(/roil|smoke|cloud|field|drape|bloom|swarm|murmur|spindrift|flux|drift|haze|plume|mist|billow|dust|vapor|fog/.test(t)) return 2;
  return -1;
}

// ---- scene morph: manual (1/2/3) + optional auto on detected long-dip->surge ----
function morphLogic(now){
  if(!autoMorph || swell < 0.08) return;
  if(sEnergy < swell*0.45 && !dipped){ dipped=true; dipT=now; }
  if(dipped && sEnergy > swell*1.15 && now-dipT > 2){ dipped=false; sceneTarget=(sceneTarget+1)%3; }
}

// ---- keys ----
addEventListener("keydown",(e)=>{
  const k = e.key;
  if(k>="1"&&k<="3"){ sceneTarget=+k-1; autoMorph=false; replayActive=false; disposeReplay(); worldStatus="world: default["+vehName(+k-1)+"] (manual vehicle)"; updateHud(); }
  else if(k==="m"){ autoMorph=!autoMorph; }
  else if(k==="v"){ replayEnabled=!replayEnabled; if(pointer>=0) arrive(pointer); }
  else if(k==="h"){ const h=document.getElementById("hud"); h.style.display = h.style.display==="none"?"block":"none"; }
  else if(k==="r"){ renderScale = renderScale===1?0.75: renderScale===0.75?0.5:1; }
  else if(k==="d"){ demo(); }
  else if(k==="ArrowRight"||k==="n"){ e.preventDefault(); arrive(pointer<0?0:pointer+1); }
  else if(k==="ArrowLeft"||k==="p"){ e.preventDefault(); arrive(pointer<0?0:pointer-1); }
  else if(k==="0"){ manualHold=!manualHold; }
  else if(k==="-"||k==="_"){ intensity=Math.max(0.4, +(intensity-0.1).toFixed(2)); updateHud(); }
  else if(k==="="||k==="+"){ intensity=Math.min(1.3, +(intensity+0.1).toFixed(2)); updateHud(); }
  else if(k==="b"){
    if(blackoutEngaged){ blackoutEngaged=false; updateHud(); }
    else if(!blackoutTimer){
      plate.classList.add("blackarm");
      blackoutTimer = setTimeout(()=>{ blackoutEngaged=true; blackoutTimer=null; plate.classList.remove("blackarm"); updateHud(); }, 360);
    }
  }
});
addEventListener("keyup",(e)=>{ if(e.key==="b" && blackoutTimer){ clearTimeout(blackoutTimer); blackoutTimer=null; plate.classList.remove("blackarm"); }});

// ---- render loop (wall clock — the live twin of u_time = frame/fps) ----
const t0 = performance.now();
let flashSlew=0;
let fps=0, fpsAcc=0, fpsT=performance.now();
function frame(){
  const now=(performance.now()-t0)/1000;
  dsp(); morphLogic(now);

  const nowMs = performance.now();
  if(sEnergy < 0.03 && swell < 0.03){ if(!silentSince) silentSince=nowMs; if(nowMs-silentSince>5000) silenceHold=true; }
  else { silentSince=0; silenceHold=false; }

  const holdTarget = (blackoutEngaged || manualHold || silenceHold) ? 1 : 0;
  holdCur += (holdTarget - holdCur) * 0.06;

  // glide the base vehicle crossfade
  const wrap = ((sceneTarget+3) - (scene%3)) % 3;
  scene += (wrap<=1.5? wrap : wrap-3) * 0.02;
  if(scene<0) scene+=3;

  // ease palette (base + replay) + seed toward the arrival target (>=1.2s)
  for(let i=0;i<12;i++){ palCur[i] += (palTar[i]-palCur[i]) * 0.035; palCurR[i] += (palTarR[i]-palCurR[i]) * 0.035; }
  seedCur += (seedTar-seedCur) * 0.035;
  seedRawCur += (seedRawTar-seedRawCur) * 0.06;

  // live u_audioDrop analog: how far above the swell baseline the energy sits.
  const dropTarget = smooth(swell*0.9, swell*1.4 + 0.05, sEnergy);
  dropEnv += (dropTarget - dropEnv) * 0.07;

  // RAIL 3 (crude flash guard)
  const proxy = (sBass+sMid+sTreble+kick) * 0.25 * intensity;
  if(proxy > flashSlew) flashSlew = Math.min(proxy, flashSlew + 0.06); else flashSlew = proxy;
  const flashScale = proxy>1e-4 ? Math.min(1, flashSlew/proxy) : 1;
  const rg = intensity * flashScale;
  const cl = (x)=>Math.min(x*rg, 1.15);

  const targetW = Math.round(innerWidth * Math.min(devicePixelRatio, 2) * renderScale);
  const targetH = Math.round(innerHeight * Math.min(devicePixelRatio, 2) * renderScale);
  if (canvas.width !== targetW || canvas.height !== targetH) { canvas.width = targetW; canvas.height = targetH; canvas2.width = targetW; canvas2.height = targetH; }

  // ------ base program (default-vehicle world; always runs = the free fallback) ------
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0,0,canvas.width,canvas.height);
  gl.uniform2f(U("u_res"),canvas.width,canvas.height);
  gl.uniform1f(U("u_time"),now);
  gl.uniform1f(U("u_bass"),cl(sBass)); gl.uniform1f(U("u_mid"),cl(sMid)); gl.uniform1f(U("u_treble"),cl(sTreble));
  gl.uniform1f(U("u_energy"),cl(sEnergy)); gl.uniform1f(U("u_kickHit"),cl(kick)); gl.uniform1f(U("u_swell"),Math.min(swell*intensity,1.1));
  const baseHidden = replayActive && replayFade > 0.996 && holdCur < 0.004;
  canvas.style.visibility = baseHidden ? "hidden" : "visible";
  if (!baseHidden) {
  gl.uniform1f(U("u_scene"),scene%3);
  gl.uniform1f(U("u_holding"),holdCur);
  gl.uniform1f(U("u_seed"),seedCur);
  gl.uniform3fv(U("u_palette[0]"), palCur);
  gl.drawArrays(gl.TRIANGLES,0,3);
  }

  // ------ replay program (the finding's OWN world) ------
  // Crossfade in over ~1.5s on arrival; fade OUT under holding/blackout (the base's
  // holding scene shows through — the rails hold: the replay never survives blackout).
  const fadeTarget = replayActive ? 1 : 0;
  replayFade += (fadeTarget - replayFade) * 0.05;   // ~1.5s ease
  const canvasOpacity = replayFade * (1 - holdCur);
  canvas2.style.opacity = canvasOpacity.toFixed(3);
  if(replayProg && replayActive && canvasOpacity > 0.004){
    const dwellMs = nowMs - arriveMs;
    const dwellSec = dwellMs/1000;
    gl2.useProgram(replayProg);
    gl2.bindBuffer(gl2.ARRAY_BUFFER, buf2); const al=gl2.getAttribLocation(replayProg,"a"); gl2.enableVertexAttribArray(al); gl2.vertexAttribPointer(al,2,gl2.FLOAT,false,0,0);
    gl2.viewport(0,0,canvas2.width,canvas2.height);
    // standard header, from the SAME live DSP as the base (canonical names)
    gl2.uniform1f(RU("u_time"), now);
    gl2.uniform2f(RU("u_res"), canvas2.width, canvas2.height);
    gl2.uniform1f(RU("u_progress"), Math.min(dwellMs/replayExpectedLenMs, 1));
    gl2.uniform1f(RU("u_energy"), cl(sEnergy));
    gl2.uniform1f(RU("u_bass"), cl(sBass));
    gl2.uniform1f(RU("u_mid"), cl(sMid));
    gl2.uniform1f(RU("u_treble"), cl(sTreble));
    gl2.uniform1f(RU("u_beatPulse"), cl(kick));
    gl2.uniform1f(RU("u_onsetPulse"), cl(kick));
    gl2.uniform1f(RU("u_audioHit"), cl(kick));
    const sw = Math.min(swell*intensity,1.1);
    gl2.uniform1f(RU("u_audioSwell"), sw);
    gl2.uniform1f(RU("u_audioDrop"), dropEnv);
    gl2.uniform1f(RU("u_audioDisturbance"), Math.min(cl(kick)*0.5 + sw*0.3 + dropEnv*0.5, 1.2));
    gl2.uniform1f(RU("u_energyFast"), cl(sEnergy));
    gl2.uniform1f(RU("u_bassFast"), cl(sBass));
    gl2.uniform1f(RU("u_midFast"), cl(sMid));
    gl2.uniform1f(RU("u_trebleFast"), cl(sTreble));
    gl2.uniform1f(RU("u_flux"), cl(kick));
    gl2.uniform1f(RU("u_sub"), cl(sBass));
    gl2.uniform1f(RU("u_kickHit"), cl(kick));
    gl2.uniform1f(RU("u_snareHit"), cl(sMid*kick));
    gl2.uniform1f(RU("u_air"), cl(sTreble));
    gl2.uniform1f(RU("u_downbeatPulse"), cl(kick));
    gl2.uniform1f(RU("u_seed"), seedRawCur);
    gl2.uniform3fv(RU("u_palette[0]"), palCurR);
    // custom uniforms — per their classified journey role
    for(const c of replayCustoms){
      const l = RU(c.name); if(l===null) continue;
      if(c.type === "vec3"){
        const st = (c.params && c.params.stop!=null) ? c.params.stop : 2;
        gl2.uniform3f(l, palCurR[st*3], palCurR[st*3+1], palCurR[st*3+2]);
      } else if(c.class === "riseRamp"){
        gl2.uniform1f(l, easeInOut(dwellSec/30));
      } else if(c.class === "settleDim"){
        gl2.uniform1f(l, (c.params && c.params.hold!=null) ? c.params.hold : 1.0);
      } else if(c.class === "audioAlias"){
        const f = (c.params && c.params.field) || "swell";
        const v = f==="bass"? cl(sBass) : f==="mid"? cl(sMid) : f==="treble"? cl(sTreble) : f==="hit"? cl(kick) : f==="drop"? dropEnv : sw;
        gl2.uniform1f(l, v);
      } else {
        gl2.uniform1f(l, 0.5); // unknown
      }
    }
    gl2.drawArrays(gl2.TRIANGLES,0,3);
    window.__replay = true;
  } else {
    window.__replay = false;
  }
  window.__frames++;

  fpsAcc++; if(nowMs-fpsT>=500){ fps=Math.round(fpsAcc*1000/(nowMs-fpsT)); fpsAcc=0; fpsT=nowMs; updateHud(); }

  document.getElementById("meters").textContent =
    "bass " + sBass.toFixed(2) + "  mid " + sMid.toFixed(2) + "  treble " + sTreble.toFixed(2) +
    "  kick " + kick.toFixed(2) + "  swell " + swell.toFixed(2) + "  drop " + dropEnv.toFixed(2);
  requestAnimationFrame(frame);
}

let deviceName="—";
function updateHud(){
  const hi = document.getElementById("hudinfo");
  let planLine;
  if(!PLAN.length) planLine = "plan: (loading)";
  else if(pointer<0){ planLine = "plan: uncharted · press → for "+PLAN[0].title; }
  else {
    const nx = PLAN[(pointer+1)%PLAN.length];
    planLine = "track "+(pointer+1)+"/"+PLAN.length+" · "+PLAN[pointer].title+"  → next "+nx.title;
  }
  const rest = blackoutEngaged?"BLACKOUT": manualHold?"holding": silenceHold?"silence-hold":"live";
  hi.textContent = planLine + "\\n" +
    "dev "+deviceName+"  ·  "+fps+"fps  ·  scene "+(scene%3).toFixed(1)+(autoMorph?" auto":"")+
    "  ·  intensity "+intensity.toFixed(1)+"  ·  "+rest + (replayEnabled?"":"  ·  replay OFF");
  const w = document.getElementById("world");
  w.textContent = worldStatus;
  w.className = replayActive ? "rep" : "dim";
}

// ---- load THE PLAN (same-origin /plan bridge — no CORS) then boot ----
fetch("/plan").then(r=>r.json()).then(list=>{
  PLAN = list||[];
  updateHud();
}).catch(e=>{ err("plan load failed: "+e); });

frame();

// ---- inputs ----
async function listDevices(){
  const sel = document.getElementById("devices");
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="audioinput");
  sel.innerHTML = devs.map(d=>"<option value='"+d.deviceId+"'>"+(d.label||"input")+"</option>").join("");
  const pick = devs.find(d=>/m-track/i.test(d.label)) || devs.find(d=>/usb audio/i.test(d.label)) || devs.find(d=>/blackhole/i.test(d.label));
  if(pick){ sel.value = pick.deviceId; }
}
document.getElementById("live").onclick = async ()=>{
  await AC.resume();
  const sel = document.getElementById("devices");
  const id = sel.value || undefined;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id?{exact:id}:undefined, echoCancellation:false, autoGainControl:false, noiseSuppression:false } });
  AC.createMediaStreamSource(stream).connect(analyser);
  await listDevices();
  deviceName = (sel.options[sel.selectedIndex]||{}).text || "input"; updateHud();
};
listDevices();

// ---- demo beat: a 174bpm DnB-ish synth through the SAME analyser ----
let demoOn=false;
function demo(){
  if(demoOn) return; demoOn=true; AC.resume(); deviceName="demo beat"; updateHud();
  const bus = AC.createGain(); bus.gain.value=0.9; bus.connect(analyser); const out=AC.createGain(); out.gain.value=0.4; bus.connect(out); out.connect(AC.destination);
  const beat = 60/174;
  function kickAt(t){ const o=AC.createOscillator(), g=AC.createGain();
    o.frequency.setValueAtTime(140,t); o.frequency.exponentialRampToValueAtTime(45,t+0.09);
    g.gain.setValueAtTime(1,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.22);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t+0.25); }
  function hatAt(t){ const b=AC.createBufferSource(), g=AC.createGain(), f=AC.createBiquadFilter();
    const buf=AC.createBuffer(1,2205,AC.sampleRate); const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
    b.buffer=buf; f.type="highpass"; f.frequency.value=6000;
    g.gain.setValueAtTime(0.25,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.05);
    b.connect(f); f.connect(g); g.connect(bus); b.start(t); }
  let bar=0;
  setInterval(()=>{ const t=AC.currentTime+0.05;
    const inBreak = (bar%16)>=12;
    if(!inBreak){ kickAt(t); kickAt(t+beat*2.5); for(let i=0;i<4;i++) hatAt(t+beat*i+beat/2); }
    bar++;
  }, beat*4*1000);
}
document.getElementById("demo").onclick = demo;
</script></body></html>`;

// ---- the /plan bridge: assemble the ordered tracklist enriched with each
// finding's palette + seed + duration + videoVehicle tag + the extracted,
// replay-ready shader scene. Same-origin -> no CORS in the page. ----
type PlanEntry = {
  logId: string;
  title: string;
  artists: string[];
  foundAt: string | null;
  palette: unknown;
  seed: number | null;
  durationMs: number | null;
  videoVehicle: string | null;
  replay: Scene;
};
let PLAN_CACHE: PlanEntry[] | null = null;

async function fetchVehicleMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const r = await fetch("https://www.fluncle.com/api/tracks?limit=500");
    if (r.ok) {
      const d = (await r.json()) as unknown;
      const items = Array.isArray(d)
        ? d
        : ((d as { tracks?: unknown[]; items?: unknown[] }).tracks ??
          (d as { items?: unknown[] }).items ??
          []);
      for (const t of items as Array<{ logId?: string; videoVehicle?: string }>) {
        if (t.logId && t.videoVehicle) {
          map[t.logId] = t.videoVehicle;
        }
      }
    }
  } catch {
    // feed unavailable → tag-map falls back to hash for every track
  }
  return map;
}

async function buildPlan(): Promise<PlanEntry[]> {
  if (PLAN_CACHE) {
    return PLAN_CACHE;
  }
  const tlPath = new URL("../plan-pointer/tracklist.json", import.meta.url);
  const tracklist = (await Bun.file(tlPath).json()) as Array<{
    logId: string;
    title: string;
    artists: string[];
    durationMs?: number;
  }>;
  const vehicleMap = await fetchVehicleMap();
  const out = await Promise.all(
    tracklist.map(async (t): Promise<PlanEntry> => {
      let palette: unknown = null;
      let seed: number | null = null;
      let title = t.title;
      let artists = t.artists;
      let foundAt: string | null = null;
      let durationMs: number | null = t.durationMs ?? null;
      try {
        const r = await fetch(`https://found.fluncle.com/${t.logId}/props.json`);
        if (r.ok) {
          const p = (await r.json()) as {
            palette?: unknown;
            seed?: number;
            track?: {
              title?: string;
              artists?: string[];
              discoveredAt?: string;
              durationMs?: number;
            };
          };
          palette = p.palette ?? null;
          seed = p.seed ?? null;
          title = p.track?.title ?? title;
          artists = p.track?.artists ?? artists;
          foundAt = p.track?.discoveredAt ?? null;
          durationMs = p.track?.durationMs ?? durationMs;
        }
      } catch {
        // props.json missing -> canon palette for this arrival
      }
      let replay: Scene = {
        customUniforms: [],
        reason: "composition.tsx unavailable",
        replayable: false,
      };
      try {
        const cr = await fetch(`https://found.fluncle.com/${t.logId}/composition.tsx`);
        if (cr.ok) {
          replay = extractScene(await cr.text());
        }
      } catch {
        // fetch failed -> non-replayable (tag-map fallback)
      }
      return {
        artists,
        durationMs,
        foundAt,
        logId: t.logId,
        palette,
        replay,
        seed,
        title,
        videoVehicle: vehicleMap[t.logId] ?? null,
      };
    }),
  );
  PLAN_CACHE = out;
  return out;
}

// Pre-extract ALL tracks at boot and log the summary table.
function logSummary(plan: PlanEntry[]): void {
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  let rep = 0;
  console.log(
    "\n" +
      pad("logId", 10) +
      pad("replay", 8) +
      pad("vehicle", 22) +
      pad("custom uniforms", 40) +
      "reason",
  );
  console.log("-".repeat(110));
  for (const e of plan) {
    if (e.replay.replayable) {
      rep++;
    }
    const cu = e.replay.customUniforms.map((c) => `${c.name}:${c.class}`).join(",");
    console.log(
      pad(e.logId, 10) +
        pad(e.replay.replayable ? "YES" : "no", 8) +
        pad((e.videoVehicle ?? "—").slice(0, 20), 22) +
        pad(cu || "(none)", 40) +
        (e.replay.replayable ? "" : (e.replay.reason ?? "")),
    );
  }
  console.log("-".repeat(110));
  console.log(`replayable: ${rep}/${plan.length}\n`);
}

Bun.serve({
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/plan") {
      const plan = await buildPlan();
      return Response.json(plan);
    }
    if (url.pathname === "/scene") {
      const logId = url.searchParams.get("logId") ?? "";
      const plan = await buildPlan();
      const e = plan.find((p) => p.logId === logId);
      return Response.json(
        e?.replay ?? { customUniforms: [], reason: "unknown logId", replayable: false },
      );
    }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  port: 4173,
});

console.log(
  "Fluncle LIVE — the glass v0.6 (dream replay) → http://localhost:4173\n" +
    "  →/n advance · ←/p rewind · 0 holding · b blackout(hold) · -/= intensity · 1/2/3 vehicle · m auto · v replay · r scale · h HUD · d demo",
);
// Pre-extract all scenes at boot and print the replayability table.
buildPlan()
  .then(logSummary)
  .catch((e) => console.error("plan/extract failed:", e));
