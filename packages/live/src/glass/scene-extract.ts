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
import {
  type SceneTextureSource,
  textureSourceForName,
} from "../../../video/src/pipeline/scene.ts";
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

/**
 * An image sampler a plate/artwork composition declares. The NAME + SOURCE are pure
 * extraction (the sampler-name convention, `textureSourceForName`); the `url` is filled
 * by the plan enrichment (it needs the finding's logId), so a replay layer carries a
 * concrete, crossOrigin-loadable URL the glass fetches + binds. Empty for the abstract
 * (textureless) vehicles — those replay exactly as before.
 */
export type SceneTexture = {
  name: string;
  source: SceneTextureSource;
  /** Resolved https URL — set by the enrichment; pure extraction leaves it undefined. */
  url?: string;
};

export type SceneLayer = {
  /** The resolved fragment body (GLSL.* deps inlined, ready for REPLAY_HEADER). */
  body: string;
  customUniforms: CustomU[];
  /** First layer paints opaque; later layers alpha-composite over (multi-layer). */
  blend: "opaque" | "over";
  /** Image samplers THIS layer's body reads (plate/plate-background/artwork). */
  textures: SceneTexture[];
};

/** The drop envelope SHAPE a composition archives via its ShaderLayer `reactivity` prop. */
export type SceneDropShape = { riseMs: number; holdMs: number; fallMs: number };

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
  /** Every image sampler the scene declares, unioned across layers (the boot-table count). */
  textures: SceneTexture[];
  /**
   * True when the scene builds toward a drop reveal — any layer reads `u_audioDrop` or drives
   * a drop-class audio alias. The live host runs the scripted arrival arc ONLY on these (an
   * abstract-era scene with no drop uniform is left exactly as before).
   */
  usesDrop: boolean;
  /**
   * The archived drop-envelope timing (rise/hold/fall) parsed from the composition's
   * `reactivity={{ drop: { … } }}` prop, when present — the live arc replays with THIS shape
   * (the composition's authored dramaturgy) instead of the canonical surge/settle.
   */
  dropShape?: SceneDropShape;
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

/** The public read base for stored bundle artifacts — where the plate textures live. */
const FOUND_BASE = "https://found.fluncle.com";

/** Slice a balanced `{ … }` region starting at/after `from` (braces included), or null. */
function balancedBraces(text: string, from: number): string | null {
  const start = text.indexOf("{", from);
  if (start < 0) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") {
      depth += 1;
    } else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * The sampler names + SOURCES a composition declares via `textures={{ name: expr, … }}`
 * on its ShaderLayer(s) — the SAME prop the offline emitter reads. The prop VALUES are
 * runtime expressions (a signed URL, `track.artworkUrl`), so the NAME is the contract:
 * `textureSourceForName` maps `u_plate`/`u_plateBackground` to the plate-lane files and
 * every other name to the finding's artwork. Reads ALL props (a multi-layer comp carries
 * one per ShaderLayer); a texture is attached to the LAYER whose body samples it.
 */
export function extractTextureSources(src: string): Map<string, SceneTextureSource> {
  const out = new Map<string, SceneTextureSource>();
  const needle = "textures=";
  let idx = 0;
  while ((idx = src.indexOf(needle, idx)) !== -1) {
    const outer = balancedBraces(src, idx + needle.length); // the JSX expr `{{ … }}`
    idx += needle.length;
    if (!outer) {
      continue;
    }
    const obj = balancedBraces(outer, 1); // the object literal `{ … }`
    if (!obj) {
      continue;
    }
    const keyRe = /([A-Za-z_$][\w$]*)\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(obj.slice(1, -1))) !== null) {
      out.set(m[1], textureSourceForName(m[1]));
    }
  }
  return out;
}

/** True when a resolved body references the sampler `name` (a `texture2D(name, …)` read). */
function bodyReferences(body: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(body);
}

/**
 * Resolve a declared texture SOURCE to a concrete, crossOrigin-loadable URL for a finding.
 * Pure + unit-tested: plate/plate-background map to the finding bundle's durable R2 keys
 * (the same files the composition rendered from); artwork binds the finding's `artworkUrl`.
 * Returns undefined when nothing resolves (an artwork sampler with no known cover) — the
 * caller drops that entry and the glass falls back rather than binding a broken image.
 */
export function resolveTextureUrl(
  source: SceneTextureSource,
  logId: string,
  artworkUrl?: string | null,
  base: string = FOUND_BASE,
): string | undefined {
  if (source === "plate") {
    return `${base}/${logId}/plate.png`;
  }
  if (source === "plate-background") {
    return `${base}/${logId}/plate.background.png`;
  }
  return artworkUrl ?? undefined;
}

/**
 * Fill every declared texture's `url` for a finding (the pure half of the enrichment):
 * resolve each layer's + the scene-level roster's samplers to concrete R2/artwork URLs,
 * dropping any that cannot resolve (an artwork sampler with no cover). A non-replayable or
 * textureless scene passes through untouched. Returns a NEW scene (no mutation), so the
 * bridge + the glass share one resolver instead of a lagging duplicate.
 */
export function resolveSceneTextureUrls(
  scene: Scene,
  logId: string,
  artworkUrl?: string | null,
  base?: string,
): Scene {
  if (!scene.replayable) {
    return scene;
  }
  const fill = (textures: SceneTexture[]): SceneTexture[] =>
    textures
      .map((t) => ({ ...t, url: resolveTextureUrl(t.source, logId, artworkUrl, base) }))
      .filter((t) => t.url !== undefined);
  return {
    ...scene,
    layers: scene.layers.map((layer) => ({ ...layer, textures: fill(layer.textures) })),
    textures: fill(scene.textures),
  };
}

// Classify a resolved body's custom uniforms; returns null (with a reason) if the
// body carries a motion/texture uniform the live host cannot re-drive. `textured` is
// the set of sampler names the composition supplies via its `textures=` prop — a
// body-declared `sampler2D` covered by that set is a real, loadable texture (not a
// rejection); one WITHOUT a source has no live upload path and still bails.
function classifyLayer(
  raw: string,
  src: string,
  textured: ReadonlySet<string>,
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
    // A sampler the composition supplies via `textures=` is a real, loadable image (the
    // glass fetches + binds it); one with no source has no live upload path -> bail.
    if (type === "sampler2D") {
      if (textured.has(name)) {
        continue;
      }
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

/**
 * Best-effort drop-shape read: the composition's ShaderLayer `reactivity={{ drop: { riseMs,
 * holdMs, fallMs, … } }}` prop (033.0.1O carries one; 025.5.5T does not). `peakTimeMs`/`floor`
 * are ignored — the live arc places the crest canonically and only honors the rise/hold/fall.
 * Returns undefined when the prop is absent or incomplete (-> the canonical arc shape).
 */
export function extractDropShape(src: string): SceneDropShape | undefined {
  const marker = "reactivity=";
  const idx = src.indexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  const outer = balancedBraces(src, idx + marker.length); // the JSX expr `{{ … }}`
  if (!outer) {
    return undefined;
  }
  const dropIdx = outer.indexOf("drop");
  if (dropIdx === -1) {
    return undefined;
  }
  const dropObj = balancedBraces(outer, dropIdx); // the `{ riseMs: …, … }` literal
  if (!dropObj) {
    return undefined;
  }
  const num = (k: string): number | undefined => {
    const m = dropObj.match(new RegExp(k + "\\s*:\\s*(-?[0-9.]+)"));
    return m ? parseFloat(m[1]) : undefined;
  };
  const riseMs = num("riseMs");
  const holdMs = num("holdMs");
  const fallMs = num("fallMs");
  if (riseMs === undefined || holdMs === undefined || fallMs === undefined) {
    return undefined;
  }
  return { fallMs, holdMs, riseMs };
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
  textures: [],
  usesDrop: false,
});

/** True when a layer body reads `u_audioDrop` or drives a drop-class audio alias. */
function layerUsesDrop(layer: SceneLayer): boolean {
  if (/\bu_audioDrop\b/.test(layer.body)) {
    return true;
  }
  return layer.customUniforms.some(
    (c) => c.class === "audioAlias" && (c.params?.field as string) === "drop",
  );
}

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
  // The sampler names + sources the composition declares via `textures=` (the plate lane).
  const textureSources = extractTextureSources(src);
  const textureNames = new Set(textureSources.keys());
  const layers: SceneLayer[] = [];
  for (let i = 0; i < rawBodies.length; i++) {
    const raw = rawBodies[i];
    const resolved = resolveGlsl(raw);
    if ("bad" in resolved) {
      return NOT_REPLAYABLE(`non-GLSL interpolation: ${resolved.bad}`);
    }
    const classified = classifyLayer(raw, src, textureNames);
    if ("reason" in classified) {
      return NOT_REPLAYABLE(classified.reason);
    }
    // Attach each declared texture to the layer whose resolved body samples it (a
    // multi-layer comp splits its plate/artwork samplers across layers by reference).
    const textures: SceneTexture[] = [];
    for (const [name, source] of textureSources) {
      if (bodyReferences(resolved.body, name)) {
        textures.push({ name, source });
      }
    }
    layers.push({
      blend: i === 0 ? "opaque" : "over",
      body: resolved.body,
      customUniforms: classified.customUniforms,
      textures,
    });
  }

  // Union of every layer's textures (dedup by name) — the scene-level roster the boot
  // table counts and the enrichment resolves to URLs.
  const sceneTextures: SceneTexture[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    for (const t of layer.textures) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        sceneTextures.push(t);
      }
    }
  }

  return {
    bloom,
    body: layers[0].body,
    customUniforms: layers[0].customUniforms,
    dropShape: extractDropShape(src),
    layers,
    replayable: true,
    textures: sceneTextures,
    usesDrop: layers.some(layerUsesDrop),
  };
}
