import { luminance } from "../remotion/color";

export const SCENE_SCHEMA = "fluncle.scene/1" as const;

export const SCENE_HEADER_VERSION = "cosmos.header/1" as const;

export const SCENE_METRICS_VERSION = "cosmos.metrics/1" as const;

export const CORE_UNIFORM_NAMES: readonly string[] = [
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
];

export const WARM_DARK_CEILING = 0.14;

export type SceneKind = "finding" | "default" | "holding";

export type SceneTextureSource = "artwork" | "plate" | "plate-background";

export const SCENE_TEXTURE_SOURCES: readonly SceneTextureSource[] = [
  "artwork",
  "plate",
  "plate-background",
];

export type SceneTexture = {
  name: string;
  source: SceneTextureSource;
};

export function textureSourceForName(name: string): SceneTextureSource {
  if (name === "u_plate") {
    return "plate";
  }
  if (name === "u_plateBackground") {
    return "plate-background";
  }
  return "artwork";
}

export type SceneGlsl = {
  body: string;

  headerVersion: string;

  glsl3: boolean;

  textures?: SceneTexture[];
};

export type ScenePalette = [string, string, string, string];

export type SceneGrain = {
  family: string;

  amount: number;
};

export type SceneBloom = {
  threshold: number;
  intensity: number;
  radius: number;
};

export type SceneReactivity = {
  drop: { riseMs: number; holdMs: number; fallMs: number };
  swellBeatWeight: number;
};

export type SceneClearedVerdict = "pass" | "fail" | "inconclusive" | "unknown";

export type SceneCleared = {
  beatPull: SceneClearedVerdict;
  flash: SceneClearedVerdict;
  arc: SceneClearedVerdict;
  metricsVersion: string;

  at: string;
};

export type Scene = {
  schema: typeof SCENE_SCHEMA;

  id: string;
  kind: SceneKind;
  glsl: SceneGlsl;
  palette: ScenePalette;
  grain: SceneGrain;
  bloom?: SceneBloom;
  reactivity?: SceneReactivity;
  cleared: SceneCleared;

  liveReady: boolean;

  liveReadyReasons: string[];
};

const FOUND_BASE = "https://found.fluncle.com";

export type SceneTextureUrls = {
  artworkUrl?: string;

  plateUrl?: string;

  plateBackgroundUrl?: string;
};

export function resolveSceneTextures(
  scene: Pick<Scene, "glsl" | "id" | "kind">,
  urls: SceneTextureUrls,
): Record<string, string> | undefined {
  const declared = scene.glsl.textures;
  if (!declared || declared.length === 0) {
    return undefined;
  }
  const bundleBase = scene.kind === "finding" ? `${FOUND_BASE}/${scene.id}` : undefined;
  const resolved: Record<string, string> = {};
  for (const texture of declared) {
    const url =
      texture.source === "plate"
        ? (urls.plateUrl ?? (bundleBase ? `${bundleBase}/plate.png` : undefined))
        : texture.source === "plate-background"
          ? (urls.plateBackgroundUrl ??
            (bundleBase ? `${bundleBase}/plate.background.png` : undefined))
          : urls.artworkUrl;
    if (url) {
      resolved[texture.name] = url;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHexTriquad(value: unknown): value is ScenePalette {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((v) => typeof v === "string" && v.length > 0)
  );
}

export function validateScene(raw: unknown): Scene | null {
  if (!isRecord(raw) || raw.schema !== SCENE_SCHEMA) {
    return null;
  }
  const glsl = raw.glsl;
  const grain = raw.grain;
  const cleared = raw.cleared;
  if (!isRecord(glsl) || !isRecord(grain) || !isRecord(cleared)) {
    return null;
  }
  if (
    typeof raw.id !== "string" ||
    (raw.kind !== "finding" && raw.kind !== "default" && raw.kind !== "holding") ||
    typeof glsl.body !== "string" ||
    typeof glsl.headerVersion !== "string" ||
    typeof glsl.glsl3 !== "boolean" ||
    !isHexTriquad(raw.palette) ||
    typeof grain.family !== "string" ||
    typeof grain.amount !== "number" ||
    typeof cleared.metricsVersion !== "string" ||
    typeof cleared.at !== "string" ||
    typeof raw.liveReady !== "boolean" ||
    !Array.isArray(raw.liveReadyReasons)
  ) {
    return null;
  }
  return raw as Scene;
}

export function lintScenePalette(scene: Pick<Scene, "palette">): string[] {
  const warnings: string[] = [];
  const ground = scene.palette[0];
  const l = luminance(ground);
  if (l > WARM_DARK_CEILING) {
    warnings.push(
      `palette[0] ${ground} has luminance ${l.toFixed(3)} > the Warm Dark ceiling ${WARM_DARK_CEILING} — a scene ground must sit near-black (The Warm Dark Rule).`,
    );
  }
  return warnings;
}

export type ResolveGlslResult = { ok: true; body: string } | { ok: false; error: string };

const GLSL_MEMBER_RE = /^GLSL\.([A-Za-z_$][A-Za-z0-9_$]*)$/;
const INTERPOLATION_RE = /\$\{([^}]*)\}/g;

export function locateFragmentLiteral(
  source: string,
): { ok: true; raw: string } | { ok: false; error: string } {
  const ticks: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "`" && source[i - 1] !== "\\") {
      ticks.push(i);
    }
  }
  for (let i = 0; i + 1 < ticks.length; i += 2) {
    const inner = source.slice(ticks[i] + 1, ticks[i + 1]);
    if (inner.includes("void main(")) {
      return { ok: true, raw: inner };
    }
  }
  return {
    error: "no fragment template literal found (no backtick-delimited body contains `void main(`)",
    ok: false,
  };
}

export function resolveGlslBody(raw: string, glsl: Record<string, string>): ResolveGlslResult {
  const bad: string[] = [];
  const body = raw.replace(INTERPOLATION_RE, (match, exprRaw: string) => {
    const expr = exprRaw.trim();
    const m = GLSL_MEMBER_RE.exec(expr);
    if (!m) {
      bad.push(`\${${expr}} is not a bare GLSL member`);
      return match;
    }
    const member = m[1];
    const snippet = glsl[member];
    if (typeof snippet !== "string") {
      bad.push(`\${GLSL.${member}} is not a member of the GLSL object`);
      return match;
    }
    return snippet;
  });
  if (bad.length > 0) {
    return {
      error: `unresolvable interpolation(s): ${bad.join("; ")} — only bare \${GLSL.*} refs are allowed`,
      ok: false,
    };
  }
  return { body, ok: true };
}

const UNIFORM_DECL_RE = /\buniform\s+\w+\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*;/g;

export function scanCustomUniforms(body: string, textureNames: string[] = []): string[] {
  const allowed = new Set<string>(CORE_UNIFORM_NAMES);
  for (const name of textureNames) {
    allowed.add(name);
    allowed.add(`${name}AspectRatio`);
  }
  const custom: string[] = [];
  UNIFORM_DECL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UNIFORM_DECL_RE.exec(body)) !== null) {
    const name = match[1];
    if (!allowed.has(name) && !custom.includes(name)) {
      custom.push(name);
    }
  }
  return custom;
}

function sliceBalancedBraces(text: string, from: number): string | null {
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

function numericFields(snippet: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

export function detectGlsl3(source: string): boolean {
  return /\bglsl3(?:\s*=\s*\{\s*true\s*\}|[\s/>])/.test(source);
}

export function extractTextureNames(source: string): string[] {
  const idx = source.indexOf("textures=");
  if (idx < 0) {
    return [];
  }
  const block = sliceBalancedBraces(source, idx);
  if (!block) {
    return [];
  }

  const inner = sliceBalancedBraces(block, 1);
  if (!inner) {
    return [];
  }
  const names: string[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner.slice(1, -1))) !== null) {
    names.push(m[1]);
  }
  return names;
}

export function extractBloom(source: string): SceneBloom | undefined {
  const idx = source.indexOf("bloom=");
  if (idx < 0) {
    return undefined;
  }
  const block = sliceBalancedBraces(source, idx);
  if (!block) {
    return undefined;
  }
  const fields = numericFields(block);
  if (
    fields.threshold === undefined &&
    fields.intensity === undefined &&
    fields.radius === undefined
  ) {
    return undefined;
  }

  return {
    intensity: fields.intensity ?? 0.8,
    radius: fields.radius ?? 1,
    threshold: fields.threshold ?? 0.7,
  };
}

export function extractReactivity(source: string): SceneReactivity | undefined {
  const idx = source.indexOf("reactivity=");
  if (idx < 0) {
    return undefined;
  }
  const block = sliceBalancedBraces(source, idx);
  if (!block) {
    return undefined;
  }
  const dropIdx = block.indexOf("drop");
  if (dropIdx < 0) {
    return undefined;
  }
  const dropBlock = sliceBalancedBraces(block, dropIdx);
  if (!dropBlock) {
    return undefined;
  }
  const drop = numericFields(dropBlock);
  if (drop.riseMs === undefined && drop.holdMs === undefined && drop.fallMs === undefined) {
    return undefined;
  }
  const top = numericFields(block.replace(dropBlock, ""));
  return {
    drop: {
      fallMs: drop.fallMs ?? 0,
      holdMs: drop.holdMs ?? 0,
      riseMs: drop.riseMs ?? 0,
    },
    swellBeatWeight: top.swellBeatWeight ?? 0,
  };
}

export function extractGrainAmount(source: string): number | undefined {
  const m = /\.amount\s*=\s*(-?\d+(?:\.\d+)?)/.exec(source);
  return m ? Number(m[1]) : undefined;
}

const HEX_LITERAL_RE = /["'`](#[0-9a-fA-F]{3,8})["'`]/g;

function hexLiterals(snippet: string): string[] {
  const out: string[] = [];
  HEX_LITERAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEX_LITERAL_RE.exec(snippet)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function fourStops(colors: string[]): ScenePalette | undefined {
  return colors.length >= 4 ? [colors[0], colors[1], colors[2], colors[3]] : undefined;
}

function escapeIdent(name: string): string {
  return name.replace(/\$/g, "\\$");
}

function constInitializer(source: string, name: string): string | undefined {
  const re = new RegExp(`\\bconst\\s+${escapeIdent(name)}\\b[^=;]*=`);
  const m = re.exec(source);
  if (!m) {
    return undefined;
  }
  const start = m.index + m[0].length;
  const end = source.indexOf(";", start);
  return source.slice(start, end < 0 ? source.length : end);
}

function jsxPropExpr(
  source: string,
  name: string,
  from: number,
): { expr: string; end: number } | undefined {
  const re = new RegExp(`\\b${name}\\s*=`);
  const m = re.exec(source.slice(from));
  if (!m) {
    return undefined;
  }
  const at = from + m.index;
  const block = sliceBalancedBraces(source, at);
  if (!block) {
    return undefined;
  }
  return { end: at + m[0].length, expr: block.slice(1, -1).trim() };
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

function extractInlinePaletteObject(source: string): ScenePalette | undefined {
  const re = /\bpalette\s*=\s*\{\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const block = sliceBalancedBraces(source, m.index);
    if (!block) {
      continue;
    }
    const fields: Record<string, string> = {};
    const fieldRe = /([A-Za-z_$][\w$]*)\s*:\s*["'`](#[0-9a-fA-F]{3,8})["'`]/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(block)) !== null) {
      fields[f[1]] = f[2];
    }
    if (fields.background && fields.accent && fields.glow && fields.ink) {
      return [fields.background, fields.accent, fields.glow, fields.ink];
    }
  }
  return undefined;
}

export function extractPaletteStops(source: string): ScenePalette | undefined {
  let from = 0;
  for (;;) {
    const prop = jsxPropExpr(source, "paletteStops", from);
    if (!prop) {
      break;
    }
    from = prop.end;
    if (prop.expr.startsWith("[")) {
      const stops = fourStops(hexLiterals(prop.expr));
      if (stops) {
        return stops;
      }
    } else if (IDENT_RE.test(prop.expr)) {
      const decl = constInitializer(source, prop.expr);
      const stops = decl ? fourStops(hexLiterals(decl)) : undefined;
      if (stops) {
        return stops;
      }
    }
  }

  return extractInlinePaletteObject(source);
}

export function hasPaletteStopsOverride(source: string): boolean {
  return /\bpaletteStops\s*=/.test(source);
}

export function foldCleared(report: unknown, at: string): SceneCleared {
  const r = isRecord(report) ? report : {};
  const beatPull = isRecord(r.beatPull) ? r.beatPull : {};
  const flash = isRecord(r.flashSafety) ? r.flashSafety : {};
  const arc = isRecord(r.arc) ? r.arc : {};

  const beatVerdict: SceneClearedVerdict =
    typeof beatPull.beatLocked === "boolean" ? (beatPull.beatLocked ? "fail" : "pass") : "unknown";
  const flashVerdict: SceneClearedVerdict =
    flash.verdict === "safe" ? "pass" : flash.verdict === "unsafe" ? "fail" : "unknown";
  const arcVerdict: SceneClearedVerdict =
    arc.verdict === "evolving"
      ? "pass"
      : arc.verdict === "dead"
        ? "fail"
        : arc.verdict === "inconclusive"
          ? "inconclusive"
          : "unknown";

  const metricsVersion =
    typeof r.metricsVersion === "string" ? r.metricsVersion : SCENE_METRICS_VERSION;

  return { arc: arcVerdict, at, beatPull: beatVerdict, flash: flashVerdict, metricsVersion };
}

export type BuildSceneInput = {
  id: string;
  kind: SceneKind;

  source: string;

  glsl: Record<string, string>;

  palette: ScenePalette;

  grainFamily: string | null;

  metricsReport: unknown;

  at: string;
};

export type BuildSceneResult = {
  scene: Scene | null;

  warnings: string[];
};

export function buildScene(input: BuildSceneInput): BuildSceneResult {
  const warnings: string[] = [];

  const located = locateFragmentLiteral(input.source);
  if (!located.ok) {
    return { scene: null, warnings: [`scene emission skipped: ${located.error}`] };
  }
  const resolved = resolveGlslBody(located.raw, input.glsl);
  if (!resolved.ok) {
    return {
      scene: null,
      warnings: [`scene emission skipped (not live-ready): ${resolved.error}`],
    };
  }

  const glsl3 = detectGlsl3(input.source);
  const textureNames = extractTextureNames(input.source);
  const customUniforms = scanCustomUniforms(resolved.body, textureNames);

  const liveReadyReasons: string[] = [];
  if (customUniforms.length > 0) {
    liveReadyReasons.push(
      `body declares custom uniform(s) beyond the header: ${customUniforms.join(", ")} — a live host cannot drive clip-time JS uniforms`,
    );
  }

  const bloom = extractBloom(input.source);
  const reactivity = extractReactivity(input.source);
  const grainAmount = extractGrainAmount(input.source);
  if (grainAmount === undefined) {
    warnings.push("grain amount not found in source — defaulting to 0.05");
  }
  if (!input.grainFamily) {
    warnings.push("grain family unset — recording `unknown`");
  }

  const renderedStops = extractPaletteStops(input.source);
  const palette = renderedStops ?? input.palette;
  if (!renderedStops && hasPaletteStopsOverride(input.source)) {
    warnings.push(
      "palette: composition declares a paletteStops override this emitter could not resolve to literal stops — recording the props (artwork) palette, which may DIVERGE from the rendered footage",
    );
  }

  const glsl: SceneGlsl = {
    body: resolved.body,
    glsl3,
    headerVersion: SCENE_HEADER_VERSION,
    ...(textureNames.length > 0
      ? { textures: textureNames.map((name) => ({ name, source: textureSourceForName(name) })) }
      : {}),
  };

  const scene: Scene = {
    cleared: foldCleared(input.metricsReport, input.at),
    glsl,
    grain: { amount: grainAmount ?? 0.05, family: input.grainFamily ?? "unknown" },
    id: input.id,
    kind: input.kind,
    liveReady: liveReadyReasons.length === 0,
    liveReadyReasons,
    palette,
    schema: SCENE_SCHEMA,
    ...(bloom ? { bloom } : {}),
    ...(reactivity ? { reactivity } : {}),
  };

  warnings.push(...lintScenePalette(scene));

  return { scene, warnings };
}
