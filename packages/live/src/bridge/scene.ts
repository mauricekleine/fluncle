// SERVER-SIDE SCENE EXTRACTION — lifted from the glass v0.6 seed (glass/serve.ts).
// This is the /plan enrichment's "dream replay" half: resolve an archived
// composition.tsx's fragment body to a self-contained, replay-ready GLSL string and
// classify its custom (journey-helper) uniforms so the glass can re-drive them live
// (rise ramps -> dwell; tail dimmers -> pinned; audio aliases -> live DSP; colour
// vec3s -> palette stops). It MOVED here from the glass so the bridge owns /plan on
// :4180; the glass keeps its own copy for standalone mode (documented precedence in
// the package README). The extraction logic is unchanged from the proven seed — the
// GLSL object is imported from @fluncle/video (its author of record) rather than
// re-declared, so the two cannot drift.

import { GLSL } from "@fluncle/video/src/remotion/journey/glsl";

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

type Cls = "riseRamp" | "settleDim" | "audioAlias" | "color" | "unknown";
export type CustomU = { name: string; type: string; class: Cls; params?: Record<string, unknown> };

function audioFieldOf(name: string, driver: string | null): string {
  const s = `${name} ${driver ?? ""}`.toLowerCase();
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
        .map((s) => Number.parseFloat(s))
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
  const m = src.match(new RegExp(`${uni}\\s*:\\s*([^,\\n}]+)`));
  if (!m) {
    return null;
  }
  const rhs = m[1].trim();
  if (/^toVec3\(|^hexToRgb\(|^\[/.test(rhs)) {
    return rhs;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(rhs)) {
    const cm = src.match(new RegExp(`const\\s+${rhs}\\s*=\\s*([\\s\\S]{0,400}?);\\s*\\n`));
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

/** Extract + resolve the replay-ready scene from a composition.tsx source string. */
export function extractScene(src: string): Scene {
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
    return {
      customUniforms: [],
      reason: `non-GLSL interpolation: ${String(bad)}`,
      replayable: false,
    };
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
export function vehicleToScene(tag: string | null | undefined): number {
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
