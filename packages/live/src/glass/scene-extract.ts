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

export type SceneTexture = {
  name: string;
  source: SceneTextureSource;

  url?: string;
};

export type SceneLayer = {
  body: string;
  customUniforms: CustomU[];

  blend: "opaque" | "over";

  textures: SceneTexture[];
};

export type SceneDropShape = { riseMs: number; holdMs: number; fallMs: number };

export type Scene = {
  replayable: boolean;
  reason?: string;

  layers: SceneLayer[];

  body?: string;
  customUniforms: CustomU[];

  bloom?: BloomConfig;

  textures: SceneTexture[];

  usesDrop: boolean;

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

const FOUND_BASE = "https://found.fluncle.com";

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

export function extractTextureSources(src: string): Map<string, SceneTextureSource> {
  const out = new Map<string, SceneTextureSource>();
  const needle = "textures=";
  let idx = 0;
  while ((idx = src.indexOf(needle, idx)) !== -1) {
    const outer = balancedBraces(src, idx + needle.length);
    idx += needle.length;
    if (!outer) {
      continue;
    }
    const obj = balancedBraces(outer, 1);
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

function bodyReferences(body: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(body);
}

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

function classifyLayer(
  raw: string,
  src: string,
  textured: ReadonlySet<string>,
): { customUniforms: CustomU[] } | { reason: string } {
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
    if (type === "sampler2D") {
      if (textured.has(name)) {
        continue;
      }
      return { reason: `texture uniform ${name} (no live upload path)` };
    }

    if (names.has(name + "Vel")) {
      customs.push({ class: "velocityPos", name, params: { type }, type });
      continue;
    }
    if (name.endsWith("Vel")) {
      customs.push({ class: "velocity", name, params: { type }, type });
      continue;
    }

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

export function extractDropShape(src: string): SceneDropShape | undefined {
  const marker = "reactivity=";
  const idx = src.indexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  const outer = balancedBraces(src, idx + marker.length);
  if (!outer) {
    return undefined;
  }
  const dropIdx = outer.indexOf("drop");
  if (dropIdx === -1) {
    return undefined;
  }
  const dropObj = balancedBraces(outer, dropIdx);
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

function layerUsesDrop(layer: SceneLayer): boolean {
  if (/\bu_audioDrop\b/.test(layer.body)) {
    return true;
  }
  return layer.customUniforms.some(
    (c) => c.class === "audioAlias" && (c.params?.field as string) === "drop",
  );
}

export function extractScene(src: string): Scene {
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
