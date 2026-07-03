// Server-side scene extraction — resolve an archived composition's fragment
// body/bodies to self-contained, replay-ready GLSL + classify their custom
// uniforms so the live host can re-drive each one's journey role LIVE.
//
// Productionized from the v0.6 monolith to close the last two replay gaps
// (RFC §3, measured 15/17 -> 17/17):
//   • MULTI-LAYER scenes (e.g. 011.9.8I = a full-bleed water ground + a localized
//     ink-bloom layer): return `layers[]`, each its own program the client renders
//     to an FBO and composites (layer 0 opaque, later layers alpha-over).
//   • VELOCITY-PAIR uniforms (e.g. 011.1.3X integrates a vec2 u_glide via u_glideVel):
//     a position uniform with a matching `…Vel` sibling is classified as a
//     `velocityPos` (JS-integrated at frame rate) + its `velocity` — no longer a
//     hard "not replayable" (the seed rejected all vec2/Vel/glide motion).
import { GLSL } from "../../../video/src/remotion/journey/glsl.ts";
import { type BloomConfig } from "./glsl-runtime.ts";
import { HEADER_UNIFORMS } from "./glsl-runtime.ts";

export type CustomUniformClass =
  | "riseRamp"
  | "settleDim"
  | "audioAlias"
  | "color"
  | "velocityPos"
  | "velocity";

export type CustomU = {
  name: string;
  type: string;
  class: CustomUniformClass;
  params?: Record<string, unknown>;
};

export type SceneLayer = {
  /** The resolved fragment body (GLSL.* deps inlined, ready for REPLAY_HEADER). */
  body: string;
  customUniforms: CustomU[];
  /** First layer paints opaque; later layers alpha-composite over (multi-layer). */
  blend: "opaque" | "over";
};

export type Scene = {
  replayable: boolean;
  reason?: string;
  /** One layer for a single-ShaderLayer comp; N for a composited one. */
  layers: SceneLayer[];
  /** Convenience mirror of layers[0] (single-layer path + the summary table). */
  body?: string;
  customUniforms: CustomU[];
  /** Bloom config read from the composition's ShaderLayer `bloom` prop, if present. */
  bloom?: BloomConfig;
};

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
  return 2;
}

function classifyFloat(
  name: string,
  driver: string | null,
): { class: CustomUniformClass; params?: Record<string, unknown> } {
  const n = name.toLowerCase();
  if (/settle|recede|close|outro/.test(n)) {
    return { class: "settleDim", params: { hold: /settle/.test(n) ? 1.0 : 0.0 } };
  }
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
  return { class: "riseRamp" };
}

/** Find the JS driver expression feeding a custom uniform (best-effort). */
export function findDriver(src: string, uni: string): string | null {
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

// Slice the /* glsl */-tagged (or plain) template literal assigned to `ident`.
function literalFor(src: string, ident: string): string | null {
  const decl = src.match(new RegExp("(?:const|let|var)\\s+" + ident + "\\s*=\\s*"));
  if (!decl || decl.index === undefined) {
    return null;
  }
  const open = src.indexOf("`", decl.index);
  if (open === -1) {
    return null;
  }
  const close = src.indexOf("`", open + 1);
  if (close === -1) {
    return null;
  }
  return src.slice(open + 1, close);
}

// All /* glsl */-tagged literals containing void main (the fallback path).
function taggedGlslBodies(src: string): string[] {
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
  return bodies;
}

// Resolve ${GLSL.member} — bare members only (D2: emission is module evaluation).
// Returns { body } on success or { bad } naming the offending interpolation.
function resolveGlsl(raw: string): { body: string } | { bad: string } {
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
  return bad ? { bad } : { body };
}

// Classify a resolved body's custom uniforms; returns null (with a reason) if the
// body carries a motion/texture uniform the live host cannot re-drive.
function classifyLayer(
  raw: string,
  src: string,
): { customUniforms: CustomU[] } | { reason: string } {
  // 1. gather all custom uniform declarations (name -> type).
  const decls: Array<{ name: string; type: string }> = [];
  const re = /^\s*uniform\s+(\w+)\s+(u_\w+)\s*(?:\[\d+\])?\s*;/gm;
  let um: RegExpExecArray | null;
  while ((um = re.exec(raw)) !== null) {
    const type = um[1];
    const name = um[2];
    if (HEADER_UNIFORMS.has(name)) {
      continue;
    }
    decls.push({ name, type });
  }
  const names = new Set(decls.map((d) => d.name));

  const customs: CustomU[] = [];
  for (const { name, type } of decls) {
    // A texture the live host has no upload path for -> not replayable.
    if (type === "sampler2D") {
      return { reason: `texture uniform ${name} (no live upload path)` };
    }
    // Velocity pair: a position with a matching `…Vel` sibling is JS-integrated.
    if (names.has(name + "Vel")) {
      customs.push({ class: "velocityPos", name, params: { type }, type });
      continue;
    }
    if (name.endsWith("Vel")) {
      customs.push({ class: "velocity", name, params: { type }, type });
      continue;
    }
    // A lone vec2 with no velocity sibling is unintegratable motion.
    if (type === "vec2") {
      return { reason: `vec2 motion uniform ${name} (no matching …Vel — not integrable)` };
    }
    if (type === "vec3") {
      customs.push({ class: "color", name, params: { stop: colorStopOf(name) }, type });
      continue;
    }
    const c = classifyFloat(name, findDriver(src, name));
    customs.push({ class: c.class, name, params: c.params, type });
  }
  return { customUniforms: customs };
}

// Best-effort bloom prop read: `bloom={{ threshold: .., intensity: .., radius: .. }}`.
function extractBloom(src: string): BloomConfig | undefined {
  const m = src.match(/bloom=\{\{([\s\S]{0,200}?)\}\}/);
  if (!m) {
    return undefined;
  }
  const num = (k: string, dflt: number): number => {
    const mm = m[1].match(new RegExp(k + "\\s*:\\s*([0-9.]+)"));
    return mm ? parseFloat(mm[1]) : dflt;
  };
  return {
    intensity: num("intensity", 0.6),
    radius: num("radius", 1),
    threshold: num("threshold", 0.72),
  };
}

const NOT_REPLAYABLE = (reason: string): Scene => ({
  customUniforms: [],
  layers: [],
  reason,
  replayable: false,
});

export function extractScene(src: string): Scene {
  // 1. Prefer the precise path: the identifiers passed as `fragmentShader={IDENT}`
  //    (in order) — this captures EVERY ShaderLayer, so multi-layer comps produce
  //    multiple layers instead of the seed's "first void main only".
  const idents: string[] = [];
  const fsRe = /fragmentShader=\{([A-Za-z_$][\w$]*)\}/g;
  let fm: RegExpExecArray | null;
  while ((fm = fsRe.exec(src)) !== null) {
    idents.push(fm[1]);
  }

  let rawBodies: string[] = [];
  if (idents.length > 0) {
    for (const id of idents) {
      const lit = literalFor(src, id);
      if (lit && /void\s+main\s*\(/.test(lit)) {
        rawBodies.push(lit);
      }
    }
  }
  // Fallback for comps that inline the shader without a named const.
  if (rawBodies.length === 0) {
    const tagged = taggedGlslBodies(src).filter((b) => /void\s+main\s*\(/.test(b));
    if (tagged.length > 0) {
      rawBodies = [tagged[0]];
    }
  }
  if (rawBodies.length === 0) {
    return NOT_REPLAYABLE("no ShaderLayer fragment with void main (untagged/DOM-only composition)");
  }

  const bloom = extractBloom(src);
  const layers: SceneLayer[] = [];
  for (let i = 0; i < rawBodies.length; i++) {
    const raw = rawBodies[i];
    const resolved = resolveGlsl(raw);
    if ("bad" in resolved) {
      return NOT_REPLAYABLE(`non-GLSL interpolation: ${resolved.bad}`);
    }
    const classified = classifyLayer(raw, src);
    if ("reason" in classified) {
      return NOT_REPLAYABLE(classified.reason);
    }
    layers.push({
      blend: i === 0 ? "opaque" : "over",
      body: resolved.body,
      customUniforms: classified.customUniforms,
    });
  }

  return {
    bloom,
    body: layers[0].body,
    customUniforms: layers[0].customUniforms,
    layers,
    replayable: true,
  };
}
